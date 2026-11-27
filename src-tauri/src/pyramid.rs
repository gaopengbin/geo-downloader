//! TIFF 内置金字塔（Overview Layers）生成
//!
//! 在已导出的 BigTIFF 文件末尾追加 Reduced-Resolution IFD，
//! 提升 GIS 软件浏览性能。支持 LZW / Deflate / 无压缩。
//! 分块处理：每次仅读 2 个 strip（一对），降采样后写入，内存可控。

use std::io::{Read, Write, Seek, SeekFrom};
use std::path::Path;

// ===== 公共类型 =====

pub struct PyramidOptions {
    pub compression: String,      // "lzw" / "deflate" / "none"
    pub min_size: u32,            // 最小层尺寸（默认 512）
    pub progress_cb: Option<Box<dyn Fn(usize, usize) + Send>>,
}

impl Default for PyramidOptions {
    fn default() -> Self {
        Self {
            compression: "deflate".to_string(),
            min_size: 512,
            progress_cb: None,
        }
    }
}

pub struct PyramidStats {
    pub levels_generated: usize,
    pub size_added_bytes: u64,
    pub elapsed_ms: u64,
}

// ===== IFD 解析 =====

struct IfdInfo {
    tile_width: u32,
    tile_height: u32,
    subfile_type: u64,
    width: u32,
    height: u32,
    channels: u32,
    bits_per_sample: u16,
    sample_format: u16,
    photometric: u16,
    nodata: Option<(u64, u64, f32)>,
    rows_per_strip: u32,
    compression_tag: u16,
    strip_offsets: Vec<u64>,
    strip_byte_counts: Vec<u64>,
    #[allow(dead_code)]
    ifd_pos: u64,
    /// IFD 中 NextIFDOffset 字段在文件中的偏移位置
    next_ifd_field_pos: u64,
}

fn read_u16(r: &mut impl Read) -> Result<u16, String> {
    let mut buf = [0u8; 2];
    r.read_exact(&mut buf).map_err(|e| format!("读取失败: {}", e))?;
    Ok(u16::from_le_bytes(buf))
}

fn read_u32(r: &mut impl Read) -> Result<u32, String> {
    let mut buf = [0u8; 4];
    r.read_exact(&mut buf).map_err(|e| format!("读取失败: {}", e))?;
    Ok(u32::from_le_bytes(buf))
}

fn read_u64(r: &mut impl Read) -> Result<u64, String> {
    let mut buf = [0u8; 8];
    r.read_exact(&mut buf).map_err(|e| format!("读取失败: {}", e))?;
    Ok(u64::from_le_bytes(buf))
}

fn write_u16(w: &mut impl Write, v: u16) -> Result<(), String> {
    w.write_all(&v.to_le_bytes()).map_err(|e| format!("写入失败: {}", e))
}

fn write_u64(w: &mut impl Write, v: u64) -> Result<(), String> {
    w.write_all(&v.to_le_bytes()).map_err(|e| format!("写入失败: {}", e))
}

fn write_bigtiff_entry(w: &mut impl Write, tag: u16, typ: u16, count: u64, value: u64) -> Result<(), String> {
    write_u16(w, tag)?;
    write_u16(w, typ)?;
    write_u64(w, count)?;
    write_u64(w, value)
}

/// 解析 BigTIFF IFD 的指定 tag 的 value/offset 字段
fn read_ifd_value(r: &mut (impl Read + Seek), tag_type: u16, count: u64, value_field: u64) -> Result<Vec<u64>, String> {
    // BigTIFF: value_field 的 8 字节可存储小数据 inline
    let elem_size: u64 = match tag_type {
        3 => 2,  // SHORT
        4 => 4,  // LONG
        16 => 8, // LONG8
        _ => return Err(format!("不支持的 tag 类型: {}", tag_type)),
    };
    let total_size = count * elem_size;

    if total_size <= 8 {
        // 数据内联在 value_field 中
        let bytes = value_field.to_le_bytes();
        let mut vals = Vec::with_capacity(count as usize);
        for i in 0..count as usize {
            let v = match tag_type {
                3 => u16::from_le_bytes([bytes[i*2], bytes[i*2+1]]) as u64,
                4 => u32::from_le_bytes([bytes[i*4], bytes[i*4+1], bytes[i*4+2], bytes[i*4+3]]) as u64,
                16 => value_field,
                _ => unreachable!(),
            };
            vals.push(v);
        }
        Ok(vals)
    } else {
        // value_field 是偏移量，读外部数据
        let saved = r.stream_position().map_err(|e| e.to_string())?;
        r.seek(SeekFrom::Start(value_field)).map_err(|e| e.to_string())?;
        let mut vals = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let v = match tag_type {
                3 => read_u16(r)? as u64,
                4 => read_u32(r)? as u64,
                16 => read_u64(r)?,
                _ => unreachable!(),
            };
            vals.push(v);
        }
        r.seek(SeekFrom::Start(saved)).map_err(|e| e.to_string())?;
        Ok(vals)
    }
}

/// 解析 BigTIFF 的指定 IFD
fn parse_bigtiff_ifd(r: &mut (impl Read + Seek), ifd_offset: u64) -> Result<IfdInfo, String> {
    r.seek(SeekFrom::Start(ifd_offset)).map_err(|e| e.to_string())?;

    let num_entries = read_u64(r)?;

    let (mut tile_width, mut tile_height, mut subfile_type) = (0, 0, 0);
    let mut width: u32 = 0;
    let mut height: u32 = 0;
    let mut channels: u32 = 1;
    let (mut bits_per_sample, mut sample_format, mut photometric) = (1, 1, 1);
    let mut nodata = None;
    let mut rows_per_strip: u32 = 0;
    let mut compression_tag: u16 = 1;
    let mut strip_offsets_type: u16 = 16;
    let mut strip_offsets_count: u64 = 0;
    let mut strip_offsets_value: u64 = 0;
    let mut strip_counts_type: u16 = 16;
    let mut strip_counts_count: u64 = 0;
    let mut strip_counts_value: u64 = 0;

    for _ in 0..num_entries {
        let tag = read_u16(r)?;
        let typ = read_u16(r)?;
        let count = read_u64(r)?;
        let value = read_u64(r)?;

        match tag {
            254 => subfile_type = value,
            322 => tile_width = value as u32,
            323 => tile_height = value as u32,
            256 => width = value as u32,                // ImageWidth
            257 => height = value as u32,               // ImageLength
            258 => bits_per_sample = value as u16,
            262 => photometric = value as u16,
            339 => sample_format = value as u16,
            42113 if typ == 2 => {
                if !(1..=128).contains(&count) { return Err("无效的 TIFF NoData 值".into()); }
                let bytes = if count <= 8 {
                    value.to_le_bytes()[..count as usize].to_vec()
                } else {
                    let saved = r.stream_position().map_err(|e| e.to_string())?;
                    r.seek(SeekFrom::Start(value)).map_err(|e| e.to_string())?;
                    let mut bytes = vec![0; count as usize];
                    r.read_exact(&mut bytes).map_err(|e| e.to_string())?;
                    r.seek(SeekFrom::Start(saved)).map_err(|e| e.to_string())?;
                    bytes
                };
                let number = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?
                    .trim_end_matches(char::from(0)).trim().parse::<f32>().map_err(|e| e.to_string())?;
                nodata = Some((count, value, number));
            }
            259 => compression_tag = value as u16,      // Compression
            277 => channels = value as u32,             // SamplesPerPixel
            278 => rows_per_strip = value as u32,       // RowsPerStrip
            273 | 324 => {                                     // StripOffsets
                strip_offsets_type = typ;
                strip_offsets_count = count;
                strip_offsets_value = value;
            }
            279 | 325 => {                                     // StripByteCounts
                strip_counts_type = typ;
                strip_counts_count = count;
                strip_counts_value = value;
            }
            _ => {}
        }
    }

    // NextIFDOffset 位于所有 entry 之后
    let next_ifd_field_pos = r.stream_position().map_err(|e| e.to_string())?;

    // 读取 strip offsets 和 byte counts
    let strip_offsets = read_ifd_value(r, strip_offsets_type, strip_offsets_count, strip_offsets_value)?;
    let strip_byte_counts = read_ifd_value(r, strip_counts_type, strip_counts_count, strip_counts_value)?;

    if width == 0 || height == 0 || (rows_per_strip == 0 && (tile_width == 0 || tile_height == 0)) {
        return Err("IFD 缺少必要 tag (width/height/rows_per_strip)".to_string());
    }

    Ok(IfdInfo {
        tile_width, tile_height, subfile_type,
        width,
        height,
        channels, bits_per_sample, sample_format, photometric, nodata,
        rows_per_strip,
        compression_tag,
        strip_offsets,
        strip_byte_counts,
        ifd_pos: ifd_offset,
        next_ifd_field_pos,
    })
}

// ===== 解压缩 =====

fn decompress_strip(data: &[u8], compression_tag: u16, expected_size: usize) -> Result<Vec<u8>, String> {
    let decoded = match compression_tag {
        1 => Ok(data.to_vec()), // 无压缩
        5 => {
            // LZW (TIFF)
            let mut decoder = weezl::decode::Decoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8);
            decoder.decode(data).map_err(|e| format!("LZW 解压失败: {}", e))
        }
        8 => {
            // Deflate (zlib)
            use flate2::read::ZlibDecoder;
            let mut decoder = ZlibDecoder::new(data);
            let mut out = Vec::with_capacity(expected_size);
            decoder.read_to_end(&mut out).map_err(|e| format!("Deflate 解压失败: {}", e))?;
            Ok(out)
        }
        _ => Err(format!("不支持的压缩格式 tag={}", compression_tag)),
    }?;
    if decoded.len() != expected_size {
        return Err(format!("TIFF 条带长度异常: 需要 {expected_size}，实际 {}", decoded.len()));
    }
    Ok(decoded)
}

// ===== 压缩 =====

fn compress_strip(data: &[u8], compression: &str) -> Result<Vec<u8>, String> {
    match compression {
        "lzw" => {
            let mut encoder = weezl::encode::Encoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8);
            encoder.encode(data).map_err(|e| format!("LZW 压缩失败: {}", e))
        }
        "deflate" => {
            use flate2::write::ZlibEncoder;
            use flate2::Compression;
            let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
            enc.write_all(data).map_err(|e| format!("Deflate 压缩: {}", e))?;
            enc.finish().map_err(|e| format!("Deflate 完成: {}", e))
        }
        _ => Ok(data.to_vec()),
    }
}

// ===== Box Average 2x 降采样（strip 级别） =====

/// 对两个相邻 strip 进行 2x 降采样（宽度和高度都减半）
/// src_top / src_bot: 原始 strip 的未压缩像素数据（RGB 或 RGBA）
/// src_width: 原图宽度
/// channels: 3 或 4
/// rows_top / rows_bot: 两个 strip 的实际行数
/// 返回: 降采样后的像素数据，宽度为 src_width/2，行数为 (rows_top+rows_bot)/2
fn box_average_strip_pair(
    src_top: &[u8],
    src_bot: &[u8],
    src_width: u32,
    channels: u32,
    rows_top: u32,
    rows_bot: u32,
) -> Vec<u8> {
    let new_w = src_width / 2;
    let combined_rows = rows_top + rows_bot;
    let new_h = combined_rows / 2;
    let ch = channels as usize;
    let stride = src_width as usize * ch;
    let new_stride = new_w as usize * ch;
    let mut dst = vec![0u8; new_h as usize * new_stride];

    for y in 0..new_h as usize {
        let src_y0 = y * 2;
        let src_y1 = y * 2 + 1;

        // 从 top 或 bot strip 中取行
        let row0 = get_row_from_pair(src_top, src_bot, rows_top as usize, src_y0, stride);
        let row1 = get_row_from_pair(src_top, src_bot, rows_top as usize, src_y1, stride);

        for x in 0..new_w as usize {
            let sx0 = x * 2;
            let sx1 = x * 2 + 1;
            for c in 0..ch {
                let v0 = row0[sx0 * ch + c] as u16;
                let v1 = row0[sx1 * ch + c] as u16;
                let v2 = row1[sx0 * ch + c] as u16;
                let v3 = row1[sx1 * ch + c] as u16;
                dst[y * new_stride + x * ch + c] = ((v0 + v1 + v2 + v3 + 2) / 4) as u8;
            }
        }
    }
    dst
}

fn average_elevation(top: &[u8], bottom: &[u8], width: usize, rows_top: usize, nodata: Option<f32>) -> Vec<u8> {
    let stride = width * 4;
    let height = (top.len() + bottom.len()) / stride;
    let mut result = Vec::with_capacity((width / 2) * (height / 2) * 4);
    for y in (0..height.saturating_sub(1)).step_by(2) {
        let row_a = get_row_from_pair(top, bottom, rows_top, y, stride);
        let row_b = get_row_from_pair(top, bottom, rows_top, y + 1, stride);
        for (a, b) in row_a.chunks_exact(8).zip(row_b.chunks_exact(8)) {
            let mut sum = 0.0f64;
            let mut count = 0;
            for sample in a.chunks_exact(4).chain(b.chunks_exact(4)) {
                let h = f32::from_le_bytes(sample.try_into().unwrap());
                if h.is_finite() && Some(h) != nodata {
                    sum += f64::from(h);
                    count += 1;
                }
            }
            let average = if count == 0 { nodata.unwrap_or(f32::NAN) } else { (sum / f64::from(count)) as f32 };
            result.extend_from_slice(&average.to_le_bytes());
        }
    }
    result
}

fn get_row_from_pair<'a>(top: &'a [u8], bot: &'a [u8], top_rows: usize, row: usize, stride: usize) -> &'a [u8] {
    if row < top_rows {
        let start = row * stride;
        &top[start..start + stride]
    } else {
        let local = row - top_rows;
        let start = local * stride;
        &bot[start..start + stride]
    }
}

// ===== 核心：构建金字塔 =====

pub fn build_pyramid<P: AsRef<Path>>(
    path: P,
    opts: PyramidOptions,
) -> Result<PyramidStats, String> {
    build_with_space_check(path.as_ref(), opts, crate::fs_util::ensure_write_space)
}

pub fn build_pyramid_cancellable<P: AsRef<Path>>(
    path: P, opts: PyramidOptions, cancel: &tokio_util::sync::CancellationToken,
) -> Result<PyramidStats, String> {
    build_with_space_check(path.as_ref(), opts, |path, bytes| {
        if cancel.is_cancelled() { return Err("任务已取消".into()); }
        crate::fs_util::ensure_write_space(path, bytes)
    })
}

fn build_with_space_check(
    path: &Path, opts: PyramidOptions, check_space: impl Fn(&Path, u64) -> Result<(), String>,
) -> Result<PyramidStats, String> {
    let start = std::time::Instant::now();

    // 验证 BigTIFF
    let mut file = std::fs::OpenOptions::new()
        .read(true).write(true)
        .open(path)
        .map_err(|e| format!("打开文件失败: {}", e))?;

    fs2::FileExt::try_lock_exclusive(&file)
        .map_err(|e| format!("无法独占写入金字塔: {e}"))?;

    // 读 header
    let mut header = [0u8; 16];
    file.read_exact(&mut header).map_err(|e| format!("读取头部: {}", e))?;
    if &header[0..2] != b"II" {
        return Err("不是 little-endian TIFF".to_string());
    }
    let version = u16::from_le_bytes([header[2], header[3]]);
    if version != 43 {
        return Err(format!("不是 BigTIFF (version={}), 金字塔仅支持 BigTIFF", version));
    }
    let first_ifd_offset = u64::from_le_bytes(header[8..16].try_into().unwrap());

    // 解析 IFD 0
    let ifd0 = parse_bigtiff_ifd(&mut file, first_ifd_offset)?;

    let compression_str = match opts.compression.as_str() {
        "lzw" | "deflate" | "none" => opts.compression.as_str(),
        _ => match ifd0.compression_tag {
            5 => "lzw",
            8 => "deflate",
            _ => "none",
        },
    };

    // 计算金字塔层数
    let max_dim = ifd0.width.max(ifd0.height);
    let level_count = if max_dim <= opts.min_size {
        0
    } else {
        ((max_dim as f64 / opts.min_size as f64).log2().ceil()) as usize
    };

    if level_count == 0 {
        return Ok(PyramidStats {
            levels_generated: 0,
            size_added_bytes: 0,
            elapsed_ms: start.elapsed().as_millis() as u64,
        });
    }

    let file_size_before = file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;

    let mut root_link = ifd0.next_ifd_field_pos;
    file.seek(SeekFrom::Start(root_link))
        .map_err(|e| e.to_string())?;
    let mut original_link = read_u64(&mut file)?;
    if ifd0.tile_width == 0 && original_link != 0 {
        let existing = parse_bigtiff_ifd(&mut file, original_link)?;
        if existing.subfile_type & 1 == 0 { return Err("TIFF 包含其他影像目录".into()); }
        if (existing.bits_per_sample, existing.sample_format, existing.channels, existing.photometric)
            == (ifd0.bits_per_sample, ifd0.sample_format, ifd0.channels, ifd0.photometric) {
            return Ok(PyramidStats { levels_generated: 0, size_added_bytes: 0, elapsed_ms: start.elapsed().as_millis() as u64 });
        }
        // Older GeoD versions wrote byte RGB overviews for Float32 elevation.
        // Keep the old link intact until the complete replacement is committed.
        if !(ifd0.sample_format == 3 && ifd0.bits_per_sample == 32 && existing.bits_per_sample == 8) {
            return Err("TIFF 概览与基图的采样格式不匹配".into());
        }
    }
    let result = if ifd0.tile_width != 0 {
        use crate::streaming_tiff::jpeg_tiff::{self, Blocks, Level};
        if (
            ifd0.tile_width,
            ifd0.tile_height,
            ifd0.compression_tag,
            ifd0.channels,
        ) != (512, 512, 7, 3)
        {
            return Err("无法为此分块 TIFF 构建金字塔".into());
        }
        let mut mask = None;
        if original_link != 0 {
            let next = parse_bigtiff_ifd(&mut file, original_link)?;
            if next.subfile_type == 4 {
                if (
                    next.width,
                    next.height,
                    next.tile_width,
                    next.tile_height,
                    next.compression_tag,
                ) != (ifd0.width, ifd0.height, 512, 512, 8)
                {
                    return Err("JPEG TIFF 有效区掩膜格式不匹配".into());
                }
                mask = Some(Blocks {
                    offsets: next.strip_offsets,
                    counts: next.strip_byte_counts,
                });
                root_link = next.next_ifd_field_pos;
                file.seek(SeekFrom::Start(root_link))
                    .map_err(|e| e.to_string())?;
                original_link = read_u64(&mut file)?;
            }
            if original_link != 0 {
                if parse_bigtiff_ifd(&mut file, original_link)?.subfile_type & 1 == 0 {
                    return Err("TIFF 包含其他影像目录".into());
                }
                return Ok(PyramidStats {
                    levels_generated: 0,
                    size_added_bytes: 0,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                });
            }
        }
        let base = Level {
            width: ifd0.width,
            height: ifd0.height,
            color: Blocks {
                offsets: ifd0.strip_offsets,
                counts: ifd0.strip_byte_counts,
            },
            mask,
        };
        jpeg_tiff::append_levels(&mut file, path, base, &opts, &check_space)
    } else {
        append_levels(
            &mut file,
            path,
            &opts,
            ifd0,
            compression_str,
            level_count,
            &check_space,
        )
    };

    match result {
        Ok((levels, first_ifd)) => {
            if let Some(first) = first_ifd {
                if let Err(error) = check_space(path, 0) {
                    file.set_len(file_size_before).map_err(|e| format!("{error}；回收金字塔空间失败: {e}"))?;
                    return Err(error);
                }
                let commit = file.seek(SeekFrom::Start(root_link))
                    .and_then(|_| file.write_all(&first.to_le_bytes()))
                    .and_then(|_| file.sync_data());
                if let Err(error) = commit {
                    file.seek(SeekFrom::Start(root_link)).and_then(|_| file.write_all(&original_link.to_le_bytes()))
                        .and_then(|_| file.sync_data()).map_err(|e| format!("恢复金字塔索引失败: {e}"))?;
                    file.set_len(file_size_before).map_err(|e| format!("回收金字塔空间失败: {e}"))?;
                    return Err(format!("提交金字塔失败: {error}"));
                }
            }
            if let Some(cb) = &opts.progress_cb { cb(level_count, level_count); }
            Ok(PyramidStats {
                levels_generated: levels,
                size_added_bytes: file.metadata().map_err(|e| e.to_string())?.len() - file_size_before,
                elapsed_ms: start.elapsed().as_millis() as u64,
            })
        }
        Err(error) => {
            file.set_len(file_size_before).map_err(|e| format!("{error}；回收金字塔空间失败: {e}"))?;
            Err(error)
        }
    }
}

fn append_levels(
    mut file: &mut std::fs::File, path: &Path, opts: &PyramidOptions,
    ifd0: IfdInfo, compression_str: &str, level_count: usize,
    check_space: impl Fn(&Path, u64) -> Result<(), String>,
) -> Result<(usize, Option<u64>), String> {
    let volume = crate::fs_util::VolumeWriteBudget::for_file(file, path);
    let float_dem = (ifd0.sample_format, ifd0.bits_per_sample, ifd0.channels, ifd0.photometric) == (3, 32, 1, 1);
    if !float_dem && !(ifd0.sample_format == 1 && ifd0.bits_per_sample == 8 &&
        matches!((ifd0.channels, ifd0.photometric), (3 | 4, 2) | (1, 1))) {
        return Err("无法为此类型的栅格构建金字塔".into());
    }
    let mut first_ifd = None;
    // 当前层的元信息，初始为 IFD 0
    let mut prev_width = ifd0.width;
    let mut prev_height = ifd0.height;
    let prev_channels = ifd0.channels;
    let mut prev_compression_tag = ifd0.compression_tag;
    let mut prev_rows_per_strip = ifd0.rows_per_strip;
    let mut prev_strip_offsets = ifd0.strip_offsets.clone();
    let mut prev_strip_byte_counts = ifd0.strip_byte_counts.clone();
    let mut prev_next_ifd_field_pos = None;

    let mut levels_generated = 0usize;

    for level in 0..level_count {
        if let Some(ref cb) = opts.progress_cb {
            cb(level, level_count);
        }

        let new_w = prev_width / 2;
        let new_h = prev_height / 2;
        if new_w == 0 || new_h == 0 {
            break;
        }

        // 降采样：逐对 strip 读取 → 2x box average → 压缩 → 追加
        let num_prev_strips = prev_strip_offsets.len();
        let ch = prev_channels;
        let prev_stride = prev_width as usize * ch as usize * usize::from(ifd0.bits_per_sample / 8);

        let new_rows_per_strip = prev_rows_per_strip; // 两个 strip 合并后 2x 降采样，行数不变

        let mut new_strip_offsets: Vec<u64> = Vec::new();
        let mut new_strip_byte_counts: Vec<u64> = Vec::new();

        // 定位到文件末尾开始追加
        file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;

        if num_prev_strips != prev_height.div_ceil(prev_rows_per_strip) as usize || prev_strip_byte_counts.len() != num_prev_strips {
            return Err("TIFF 条带索引数量与影像高度不一致".into());
        }
        for i in (0..num_prev_strips).step_by(2) {
            let mut read_strip = |index: usize| -> Result<Vec<u8>, String> {
                let data = read_strip_data(&mut file, prev_strip_offsets[index], prev_strip_byte_counts[index] as usize)?;
                let rows = prev_rows_per_strip.min(prev_height - index as u32 * prev_rows_per_strip);
                decompress_strip(&data, prev_compression_tag, prev_stride * rows as usize)
            };
            let top = read_strip(i)?;
            let bottom = if i + 1 < num_prev_strips { read_strip(i + 1)? } else { Vec::new() };
            let rows_top = top.len() / prev_stride;
            let rows_bottom = bottom.len() / prev_stride;
            let downsampled = if float_dem {
                average_elevation(&top, &bottom, prev_width as usize, rows_top, ifd0.nodata.map(|n| n.2))
            } else {
                box_average_strip_pair(&top, &bottom, prev_width, ch, rows_top as u32, rows_bottom as u32)
            };
            if downsampled.is_empty() { continue; }
            let compressed = compress_strip(&downsampled, compression_str)?;
            let offset = file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
            let _reservation = volume.reserve(compressed.len() as u64, |total| check_space(path, total))?;
            file.write_all(&compressed).map_err(|e| format!("写入 strip: {e}"))?;
            new_strip_offsets.push(offset);
            new_strip_byte_counts.push(compressed.len() as u64);
        }

        if new_strip_offsets.is_empty() {
            break;
        }

        // 写 StripOffsets / StripByteCounts 数组（count>1 外部存储，count==1 inline）
        let num_new_strips = new_strip_offsets.len() as u64;
        let _reservation = volume.reserve(num_new_strips * 16 + 1024, |total| check_space(path, total))?;
        let (strip_offsets_val, strip_counts_val);

        if num_new_strips == 1 {
            // BigTIFF: 1 * LONG8 = 8 bytes <= 8，必须 inline
            strip_offsets_val = new_strip_offsets[0];
            strip_counts_val = new_strip_byte_counts[0];
        } else {
            // 外部存储
            file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
            strip_offsets_val = file.stream_position().map_err(|e| e.to_string())?;
            for &off in &new_strip_offsets {
                write_u64(&mut file, off)?;
            }
            strip_counts_val = file.stream_position().map_err(|e| e.to_string())?;
            for &cnt in &new_strip_byte_counts {
                write_u64(&mut file, cnt)?;
            }
        }

        // BitsPerSample inline
        let bps_inline = (0..ch).fold(0u64, |bits, i| bits | (u64::from(ifd0.bits_per_sample) << (i * 16)));
        let res_inline: u64 = 72u64 | (1u64 << 32);
        let comp_tag_val: u64 = match compression_str { "lzw" => 5, "deflate" => 8, _ => 1 };

        // 写 IFD
        let new_ifd_pos = file.stream_position().map_err(|e| e.to_string())?;

        let has_alpha = ch == 4;
        let num_entries = 13 + u64::from(has_alpha) + u64::from(float_dem) + u64::from(ifd0.nodata.is_some());
        write_u64(&mut file, num_entries)?;

        // tag 254: NewSubfileType = 1 (reduced-resolution)
        write_bigtiff_entry(&mut file, 254, 4, 1, 1)?;
        write_bigtiff_entry(&mut file, 256, 4, 1, new_w as u64)?;                     // ImageWidth
        write_bigtiff_entry(&mut file, 257, 4, 1, new_h as u64)?;                     // ImageLength
        write_bigtiff_entry(&mut file, 258, 3, ch as u64, bps_inline)?;               // BitsPerSample
        write_bigtiff_entry(&mut file, 259, 3, 1, comp_tag_val)?;                     // Compression
        write_bigtiff_entry(&mut file, 262, 3, 1, u64::from(ifd0.photometric))?;
        write_bigtiff_entry(&mut file, 273, 16, num_new_strips, strip_offsets_val)?;   // StripOffsets
        write_bigtiff_entry(&mut file, 277, 3, 1, ch as u64)?;                        // SamplesPerPixel
        write_bigtiff_entry(&mut file, 278, 4, 1, new_rows_per_strip as u64)?;        // RowsPerStrip
        write_bigtiff_entry(&mut file, 279, 16, num_new_strips, strip_counts_val)?;   // StripByteCounts
        write_bigtiff_entry(&mut file, 282, 5, 1, res_inline)?;                       // XResolution
        write_bigtiff_entry(&mut file, 283, 5, 1, res_inline)?;                       // YResolution
        write_bigtiff_entry(&mut file, 296, 3, 1, 2)?;                                // ResolutionUnit
        if has_alpha {
            write_bigtiff_entry(&mut file, 338, 3, 1, 2)?;                            // ExtraSamples = Unassociated Alpha
        }

        if float_dem { write_bigtiff_entry(&mut file, 339, 3, 1, 3)?; }
        if let Some((count, value, _)) = ifd0.nodata {
            write_bigtiff_entry(&mut file, 42113, 2, count, value)?;
        }

        let this_next_ifd_pos = file.stream_position().map_err(|e| e.to_string())?;
        write_u64(&mut file, 0)?; // NextIFDOffset = 0（后续层会覆写）

        // 回填前一个 IFD 的 NextIFDOffset 指向新 IFD
        if let Some(link) = prev_next_ifd_field_pos {
            file.seek(SeekFrom::Start(link)).map_err(|e| e.to_string())?;
            write_u64(&mut file, new_ifd_pos)?;
        } else {
            first_ifd = Some(new_ifd_pos);
        }

        // 更新循环状态
        prev_width = new_w;
        prev_height = new_h;
        prev_rows_per_strip = new_rows_per_strip;
        prev_compression_tag = match compression_str { "lzw" => 5, "deflate" => 8, _ => 1 };
        prev_strip_offsets = new_strip_offsets;
        prev_strip_byte_counts = new_strip_byte_counts;
        prev_next_ifd_field_pos = Some(this_next_ifd_pos);
        levels_generated += 1;
    }

    file.sync_data().map_err(|e| format!("写入金字塔数据失败: {e}"))?;
    Ok((levels_generated, first_ifd))
}

fn read_strip_data(file: &mut std::fs::File, offset: u64, size: usize) -> Result<Vec<u8>, String> {
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; size];
    file.read_exact(&mut buf).map_err(|e| format!("读取 strip: {}", e))?;
    Ok(buf)
}

#[cfg(test)]
mod storage_tests {
    use super::*;

    #[test]
    fn elevations_average_float_values_and_exclude_nodata() {
        let bytes = |values: &[f32]| values.iter().flat_map(|value| value.to_le_bytes()).collect::<Vec<_>>();
        let nd = -9999.0;
        let top = bytes(&[-2.25, 3.75, nd, nd]);
        let bottom = bytes(&[1.5, nd, nd, nd]);
        assert_eq!(average_elevation(&top, &bottom, 4, 1, Some(nd)), bytes(&[1.0, nd]));
    }

    #[test]
    fn failed_pyramid_append_restores_original_file_and_can_retry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("影像.tif");
        let bounds = crate::tile::get_merged_bounds(0, 0, 1, 3, 4);
        crate::streaming_tiff::merge_and_export_streaming_with_budget(
            &Default::default(), 0, 0, 1, 3, &bounds, &path, "deflate", None, 1024,
        ).unwrap();
        let original = std::fs::read(&path).unwrap();
        let checks = std::cell::Cell::new(0);
        let result = build_with_space_check(&path, PyramidOptions::default(), |_, next| {
            checks.set(checks.get() + 1);
            if checks.get() == 1 { return Ok(()); }
            crate::fs_util::check_write_space(crate::fs_util::MIN_FREE_SPACE_BYTES, next)
        });
        assert!(result.err().unwrap().contains("磁盘空间不足"));
        assert_eq!(std::fs::read(&path).unwrap(), original);
        let stats = build_pyramid(&path, PyramidOptions::default()).unwrap();
        assert_eq!(stats.levels_generated, 1);
        assert_eq!(path.metadata().unwrap().len(), original.len() as u64 + stats.size_added_bytes);
        let after = std::fs::read(&path).unwrap();
        let repeat = build_pyramid(&path, PyramidOptions::default()).unwrap();
        assert_eq!((repeat.levels_generated, repeat.size_added_bytes), (0, 0));
        assert_eq!(std::fs::read(&path).unwrap(), after);
        let mut tiff = tiff::decoder::Decoder::new(std::fs::File::open(path).unwrap()).unwrap();
        assert_eq!(tiff.dimensions().unwrap(), (512, 1024));
        tiff.next_image().unwrap();
        assert_eq!(tiff.dimensions().unwrap(), (256, 512));
        tiff.read_image().unwrap();
    }
}
