//! Tiled JPEG-in-BigTIFF for RGB imagery. A separate lossless mask IFD keeps
//! clipped boundaries and missing coverage independent of JPEG quantization.
use super::*;
use std::io::{Cursor, Read};

const SIDE: u32 = 512;
const PIXELS: usize = (SIDE * SIDE) as usize;

#[derive(Default)]
pub(crate) struct Blocks {
    pub offsets: Vec<u64>,
    pub counts: Vec<u64>,
}

impl Blocks {
    fn write(&mut self, w: &mut (impl Write + Seek), bytes: &[u8]) -> Result<(), String> {
        self.offsets.push(stream_pos(w)?);
        w.write_all(bytes).map_err(e2s)?;
        self.counts.push(bytes.len() as u64);
        Ok(())
    }

    fn read(&self, file: &mut std::fs::File, index: usize) -> Result<Vec<u8>, String> {
        let offset = self.offsets.get(index).ok_or("JPEG TIFF 分块索引缺失")?;
        let size = *self.counts.get(index).ok_or("JPEG TIFF 分块长度缺失")?;
        if size > 8 * 1024 * 1024 {
            return Err("JPEG TIFF 分块长度异常".into());
        }
        file.seek(SeekFrom::Start(*offset)).map_err(e2s)?;
        let mut data = vec![0; size as usize];
        file.read_exact(&mut data).map_err(e2s)?;
        Ok(data)
    }
}

fn align_directory(w: &mut (impl Write + Seek)) -> Result<(), String> {
    let padding = (8 - stream_pos(w)? % 8) % 8;
    w.write_all(&[0; 8][..padding as usize]).map_err(e2s)
}

fn array_field(w: &mut (impl Write + Seek), values: &[u64]) -> Result<u64, String> {
    if let [single] = values {
        return Ok(*single);
    }
    let pos = stream_pos(w)?;
    for &v in values {
        write_u64(w, v)?;
    }
    Ok(pos)
}

// Returns this IFD's offset and the position of its next-directory pointer.
fn directory(
    w: &mut (impl Write + Seek),
    blocks: &Blocks,
    width: u32,
    height: u32,
    is_mask: bool,
    reduced: bool,
    bounds: Option<&TileBounds>,
) -> Result<(u64, u64), String> {
    align_directory(w)?;
    let count = blocks.offsets.len() as u64;
    let offsets = array_field(w, &blocks.offsets)?;
    let counts = array_field(w, &blocks.counts)?;
    let mut tags: Vec<(u16, u16, u64, u64)> = vec![
        (254, 4, 1, u64::from(reduced) + if is_mask { 4 } else { 0 }),
        (256, 4, 1, width.into()),
        (257, 4, 1, height.into()),
        (
            258,
            3,
            if is_mask { 1 } else { 3 },
            if is_mask { 1 } else { 8u64 | 8 << 16 | 8 << 32 },
        ),
        (259, 3, 1, if is_mask { 8 } else { 7 }),
        (262, 3, 1, if is_mask { 4 } else { 6 }),
        (277, 3, 1, if is_mask { 1 } else { 3 }),
        (284, 3, 1, 1),
        (322, 4, 1, SIDE.into()),
        (323, 4, 1, SIDE.into()),
        (324, 16, count, offsets),
        (325, 16, count, counts),
    ];
    if !is_mask {
        // image's JPEG encoder emits one Y, Cb and Cr block per MCU (4:4:4).
        tags.push((530, 3, 2, 1 | 1 << 16));
    }
    if let Some(bounds) = bounds {
        let (west, south, east, north) = bounds_to_mercator(bounds);
        let scale = stream_pos(w)?;
        for v in [
            (east - west) / f64::from(width),
            (north - south) / f64::from(height),
            0.0,
        ] {
            write_f64(w, v)?;
        }
        let tie = stream_pos(w)?;
        for v in [0.0, 0.0, 0.0, west, north, 0.0] {
            write_f64(w, v)?;
        }
        let keys = stream_pos(w)?;
        for v in [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 3857] {
            write_u16(w, v)?;
        }
        tags.extend([
            (33550, 12, 3, scale),
            (33922, 12, 6, tie),
            (34735, 3, 16, keys),
        ]);
    }
    let pos = stream_pos(w)?;
    write_u64(w, tags.len() as u64)?;
    for (tag, ty, n, value) in tags {
        write_bigtiff_entry(w, tag, ty, n, value)?;
    }
    let link = stream_pos(w)?;
    write_u64(w, 0)?;
    Ok((pos, link))
}

fn write_link(w: &mut (impl Write + Seek), link: u64, target: u64) -> Result<(), String> {
    w.seek(SeekFrom::Start(link)).map_err(e2s)?;
    write_u64(w, target)?;
    w.seek(SeekFrom::End(0)).map_err(e2s)?;
    Ok(())
}

fn encode(rgb: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 75)
        .encode(rgb, SIDE, SIDE, image::ExtendedColorType::Rgb8)
        .map_err(e2s)?;
    Ok(out)
}

// Limit concurrent 512px blocks across a wide row. Each lane needs RGB,
// decoded source pixels, a mask, and encoder scratch. Rayon shares its pool
// across simultaneous exports; the memory budget also applies on small hosts.
fn jpeg_lanes(budget: u64) -> usize {
    rayon::current_num_threads().min((budget / (4 * 1024 * 1024)).clamp(1, 8) as usize)
}

fn valid(mask: &[u8], pixel: usize) -> bool {
    mask[pixel / 8] & (128 >> (pixel % 8)) != 0
}
fn cover(mask: &mut [u8], pixel: usize) {
    mask[pixel / 8] |= 128 >> (pixel % 8);
}

fn encode_base_block(
    files: &HashMap<(u32, u32), TileSource>,
    tile_x: u32,
    tile_y: u32,
    pixel_x: u32,
    spans: &[Vec<(i32, i32)>],
    masked: bool,
    clip: bool,
) -> Result<(Vec<u8>, Option<Vec<u8>>, StripTimes), String> {
    let mut times = StripTimes::default();
    let mut rgb = vec![if masked { 0 } else { 255 }; PIXELS * 3];
    let mut mask = if masked {
        vec![0; PIXELS / 8]
    } else {
        Vec::new()
    };
    for ty in 0..2 {
        for tx in 0..2 {
            let Some(src) = files.get(&(tile_x + tx, tile_y + ty)) else {
                continue;
            };
            let start = std::time::Instant::now();
            let image = src.decode_work_tile(tile_x + tx, tile_y + ty)?.into_rgba8();
            times.read_decode += start.elapsed();
            let start = std::time::Instant::now();
            for y in 0..TILE_SIZE.min(image.height()) {
                let ly = ty * TILE_SIZE + y;
                let Some(row) = spans.get(ly as usize) else {
                    continue;
                };
                for x in 0..TILE_SIZE.min(image.width()) {
                    let lx = tx * TILE_SIZE + x;
                    let gx = (pixel_x + lx) as i32;
                    let p = image.get_pixel(x, y).0;
                    if masked {
                        let covered = !clip
                            || row
                                .get(row.partition_point(|&(_, right)| right <= gx))
                                .is_some_and(|&(left, _)| left <= gx);
                        if p[3] == 0 || !covered {
                            continue;
                        }
                        cover(&mut mask, (ly * SIDE + lx) as usize);
                    }
                    let i = ((ly * SIDE + lx) * 3) as usize;
                    rgb[i..i + 3].copy_from_slice(&p[..3]);
                }
            }
            times.assemble_crop += start.elapsed();
        }
    }
    let start = std::time::Instant::now();
    let jpeg = encode(&rgb)?;
    let mask = masked.then(|| deflate_compress(&mask)).transpose()?;
    times.encode += start.elapsed();
    Ok((jpeg, mask, times))
}

pub(super) fn export(
    files: &HashMap<(u32, u32), TileSource>,
    x_min: u32,
    y_min: u32,
    width: u32,
    height: u32,
    bounds: &TileBounds,
    path: &Path,
    rings: &[Vec<(i32, i32)>],
    masked: bool,
    options: StripWriteOptions,
) -> Result<u64, String> {
    export_blocks(width, height, Some(bounds), path, rings, masked, options, |bx, by, spans| {
        encode_base_block(files, x_min + bx * 2, y_min + by * 2, bx * SIDE, spans, masked, !rings.is_empty())
    })
}

pub(crate) fn export_pixels<I>(
    image: &I, bounds: Option<&TileBounds>, path: &Path, masked: bool,
) -> Result<u64, String>
where
    I: image::GenericImageView + Sync,
    I::Pixel: image::Pixel<Subpixel = u8>,
{
    use image::Pixel;
    let (width, height) = image.dimensions();
    export_blocks(width, height, bounds, path, &[], masked, export_buffer_bytes().into(), |bx, by, _| {
        let mut rgb = vec![0; PIXELS * 3];
        let mut mask = masked.then(|| vec![0; PIXELS / 8]);
        for y in 0..SIDE.min(height - by * SIDE) {
            for x in 0..SIDE.min(width - bx * SIDE) {
                let pixel = image.get_pixel(bx * SIDE + x, by * SIDE + y).to_rgba().0;
                let idx = (y * SIDE + x) as usize;
                if let Some(mask) = &mut mask {
                    if pixel[3] == 0 { continue; }
                    cover(mask, idx);
                }
                rgb[idx * 3..idx * 3 + 3].copy_from_slice(&pixel[..3]);
            }
        }
        Ok((encode(&rgb)?, mask.as_deref().map(deflate_compress).transpose()?, StripTimes::default()))
    })
}

fn export_blocks(
    width: u32, height: u32, bounds: Option<&TileBounds>, path: &Path,
    rings: &[Vec<(i32, i32)>], masked: bool, mut options: StripWriteOptions,
    encode_block: impl Fn(u32, u32, &[Vec<(i32, i32)>]) -> Result<(Vec<u8>, Option<Vec<u8>>, StripTimes), String> + Sync,
) -> Result<u64, String> {
    let (file, staged) = staged_raster(path)?;
    let mut w = BufWriter::new(RasterFile::new_empty(file, &staged, &options));
    w.write_all(b"II\x2b\0\x08\0\0\0").map_err(e2s)?;
    write_u64(&mut w, 0)?;
    let cols = width.div_ceil(SIDE);
    let rows = height.div_ceil(SIDE);
    let mut colors = Blocks::default();
    let mut masks = Blocks::default();
    let mut times = StripTimes::default();
    let lanes = jpeg_lanes(options.buffer_bytes);
    let empty = if masked && !rings.is_empty() {
        Some((
            encode(&vec![0; PIXELS * 3])?,
            deflate_compress(&vec![0; PIXELS / 8])?,
        ))
    } else {
        None
    };
    for by in 0..rows {
        let spans: Vec<_> = (0..SIDE.min(height - by * SIDE))
            .map(|y| scanline_spans(rings, (by * SIDE + y) as i32))
            .collect();
        for first in (0..cols).step_by(lanes) {
            check_cancelled(options.cancellation.as_ref())?;
            let end = cols.min(first + lanes as u32);
            let blocks = (first..end)
                .into_par_iter()
                .map(|bx| {
                    let left = i64::from(bx * SIDE);
                    let right = left + i64::from(SIDE);
                    if let Some((color, mask)) = &empty {
                        if !spans.iter().any(|row| {
                            row.get(row.partition_point(|&(_, stop)| i64::from(stop) <= left))
                                .is_some_and(|&(start, _)| i64::from(start) < right)
                        }) {
                            return Ok((color.clone(), Some(mask.clone()), StripTimes::default()));
                        }
                    }
                    encode_block(bx, by, &spans)
                })
                .collect::<Result<Vec<_>, String>>()?;
            for (jpeg, mask, elapsed) in blocks {
                times.read_decode += elapsed.read_decode;
                times.assemble_crop += elapsed.assemble_crop;
                times.encode += elapsed.encode;
                let start = std::time::Instant::now();
                colors.write(&mut w, &jpeg)?;
                if let Some(mask) = mask {
                    masks.write(&mut w, &mask)?;
                }
                times.write += start.elapsed();
            }
        }
        if let Some(cb) = &mut options.progress {
            cb(by + 1, rows, stream_pos(&mut w)?, times);
        }
    }
    let (root, link) = directory(&mut w, &colors, width, height, false, false, bounds)?;
    if masked {
        let (mask, ..) = directory(&mut w, &masks, width, height, true, false, None)?;
        write_link(&mut w, link, mask)?;
    }
    write_link(&mut w, 8, root)?;
    commit_tiff(w, staged, path, root, options.cancellation.as_ref())
}

pub(crate) struct Level {
    pub width: u32,
    pub height: u32,
    pub color: Blocks,
    pub mask: Option<Blocks>,
}

struct ParentBlock {
    dx: u32,
    dy: u32,
    width: u32,
    height: u32,
    jpeg: Vec<u8>,
    mask: Option<Vec<u8>>,
}

impl Level {
    fn read_parents(
        &self,
        file: &mut std::fs::File,
        bx: u32,
        by: u32,
    ) -> Result<Vec<ParentBlock>, String> {
        let mut group = Vec::with_capacity(4);
        let cols = self.width.div_ceil(SIDE);
        for dy in 0..2 {
            for dx in 0..2 {
                let (x, y) = (bx * 2 + dx, by * 2 + dy);
                if x >= cols || y >= self.height.div_ceil(SIDE) {
                    continue;
                }
                let index = (u64::from(y) * u64::from(cols) + u64::from(x)) as usize;
                group.push(ParentBlock {
                    dx,
                    dy,
                    width: (self.width - x * SIDE).min(SIDE),
                    height: (self.height - y * SIDE).min(SIDE),
                    jpeg: self.color.read(file, index)?,
                    mask: self
                        .mask
                        .as_ref()
                        .map(|blocks| blocks.read(file, index))
                        .transpose()?,
                });
            }
        }
        Ok(group)
    }
}

// Only the owning file handle reads and writes the locked BigTIFF. Rayon
// workers decode and encode bounded groups entirely in memory.
fn encode_child(
    parents: Vec<ParentBlock>,
    masked: bool,
) -> Result<(Vec<u8>, Option<Vec<u8>>), String> {
    let mut rgb = vec![0; PIXELS * 3];
    let mut mask = masked.then(|| vec![0; PIXELS / 8]);
    for ParentBlock {
        dx,
        dy,
        width: w,
        height: h,
        jpeg,
        mask: compressed_mask,
    } in parents
    {
        let image = image::load_from_memory(&jpeg).map_err(e2s)?.into_rgb8();
        if image.dimensions() != (SIDE, SIDE) {
            return Err("JPEG TIFF 分块尺寸不符".into());
        }
        let src_mask = if let Some(data) = compressed_mask {
            let mut m = vec![0; PIXELS / 8];
            flate2::read::ZlibDecoder::new(Cursor::new(data))
                .read_exact(&mut m)
                .map_err(e2s)?;
            Some(m)
        } else {
            None
        };
        for j in (0..h).step_by(2) {
            for i in (0..w).step_by(2) {
                let mut sum = [0u32; 3];
                let mut n = 0;
                for sy in j..(j + 2).min(h) {
                    for sx in i..(i + 2).min(w) {
                        if src_mask
                            .as_ref()
                            .is_some_and(|m| !valid(m, (sy * SIDE + sx) as usize))
                        {
                            continue;
                        }
                        for (v, c) in sum.iter_mut().zip(image.get_pixel(sx, sy).0) {
                            *v += u32::from(c);
                        }
                        n += 1;
                    }
                }
                if n > 0 {
                    let pixel =
                        ((dy * (SIDE / 2) + j / 2) * SIDE + dx * (SIDE / 2) + i / 2) as usize;
                    for (out, v) in rgb[pixel * 3..pixel * 3 + 3].iter_mut().zip(sum) {
                        *out = ((v + n / 2) / n) as u8;
                    }
                    if let Some(mask) = &mut mask {
                        cover(mask, pixel);
                    }
                }
            }
        }
    }
    Ok((
        encode(&rgb)?,
        mask.map(|m| deflate_compress(&m)).transpose()?,
    ))
}

pub(crate) fn append_levels(
    file: &mut std::fs::File,
    path: &Path,
    mut prev: Level,
    opts: &crate::pyramid::PyramidOptions,
    check_space: impl Fn(&Path, u64) -> Result<(), String>,
) -> Result<(usize, Option<u64>), String> {
    let mut first = None;
    let mut tail = None;
    let mut count = 0;
    let min = opts.min_size.max(1);
    let levels = (f64::from(prev.width.max(prev.height)) / f64::from(min))
        .log2()
        .ceil()
        .max(0.) as usize;
    let volume = crate::fs_util::VolumeWriteBudget::for_file(file, path);
    let lane_count = jpeg_lanes(export_buffer_bytes());
    while prev.width.max(prev.height) > min {
        if let Some(cb) = &opts.progress_cb {
            cb(count, levels);
        }
        let (w, h) = (prev.width.div_ceil(2), prev.height.div_ceil(2));
        let mut color = Blocks::default();
        let mut mask = prev.mask.as_ref().map(|_| Blocks::default());
        for by in 0..h.div_ceil(SIDE) {
            let cols = w.div_ceil(SIDE);
            for first in (0..cols).step_by(lane_count) {
                let end = cols.min(first + lane_count as u32);
                let parents = (first..end)
                    .map(|bx| prev.read_parents(file, bx, by))
                    .collect::<Result<Vec<_>, _>>()?;
                let children = parents
                    .into_par_iter()
                    .map(|group| encode_child(group, prev.mask.is_some()))
                    .collect::<Result<Vec<_>, _>>()?;
                file.seek(SeekFrom::End(0)).map_err(e2s)?;
                for (jpeg, bits) in children {
                    let bytes = (jpeg.len() + bits.as_ref().map_or(0, Vec::len)) as u64;
                    let _reservation = volume.reserve(bytes, |total| check_space(path, total))?;
                    color.write(file, &jpeg)?;
                    if let (Some(mask), Some(bits)) = (&mut mask, bits) {
                        mask.write(file, &bits)?;
                    }
                }
            }
        }
        let footer = color.offsets.len() as u64 * (if mask.is_some() { 32 } else { 16 }) + 4096;
        let _reservation = volume.reserve(footer, |total| check_space(path, total))?;
        let (pos, mut link) = directory(file, &color, w, h, false, true, None)?;
        if let Some(blocks) = &mask {
            let (m, next) = directory(file, blocks, w, h, true, true, None)?;
            write_link(file, link, m)?;
            link = next;
        }
        if let Some(last) = tail {
            write_link(file, last, pos)?;
        } else {
            first = Some(pos);
        }
        tail = Some(link);
        count += 1;
        prev = Level {
            width: w,
            height: h,
            color,
            mask,
        };
    }
    Ok((count, first))
}
