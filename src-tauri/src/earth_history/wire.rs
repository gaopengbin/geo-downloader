use super::Result;

#[derive(Debug, Clone, Copy)]
pub enum Value<'a> {
    Int(u64),
    Bytes(&'a [u8]),
    F32(u32),
    #[allow(dead_code)]
    F64(u64),
}
#[derive(Debug, Clone, Copy)]
pub struct Field<'a> {
    pub number: u32,
    pub value: Value<'a>,
}

pub fn varint(data: &[u8], at: &mut usize) -> Result<u64> {
    let mut value = 0;
    for shift in (0..70).step_by(7) {
        let byte = *data.get(*at).ok_or("EARTH_PROTOCOL: truncated varint")?;
        *at += 1;
        if shift == 63 && byte > 1 {
            return Err("EARTH_PROTOCOL: varint overflow".into());
        }
        value |= u64::from(byte & 127) << shift;
        if byte < 128 {
            return Ok(value);
        }
    }
    Err("EARTH_PROTOCOL: invalid varint".into())
}

pub fn parse(data: &[u8]) -> Result<Vec<Field<'_>>> {
    if data.len() > 32 * 1024 * 1024 {
        return Err("EARTH_BUDGET: protobuf exceeds 32 MiB".into());
    }
    let mut fields = Vec::new();
    let mut at = 0;
    while at < data.len() {
        if fields.len() >= 100_000 {
            return Err("EARTH_BUDGET: too many protobuf fields".into());
        }
        let key = varint(data, &mut at)?;
        let number =
            u32::try_from(key >> 3).map_err(|_| "EARTH_PROTOCOL: field number overflow")?;
        if number == 0 || number > 0x1fff_ffff {
            return Err("EARTH_PROTOCOL: invalid field number".into());
        }
        let value = match key & 7 {
            0 => Value::Int(varint(data, &mut at)?),
            wire @ (1 | 2 | 5) => {
                let length = match wire {
                    1 => 8,
                    5 => 4,
                    _ => usize::try_from(varint(data, &mut at)?)
                        .map_err(|_| "EARTH_PROTOCOL: length overflow")?,
                };
                let end = at
                    .checked_add(length)
                    .filter(|&n| n <= data.len())
                    .ok_or("EARTH_PROTOCOL: truncated field")?;
                let bytes = &data[at..end];
                at = end;
                match wire {
                    1 => Value::F64(u64::from_le_bytes(bytes.try_into().unwrap())),
                    5 => Value::F32(u32::from_le_bytes(bytes.try_into().unwrap())),
                    _ => Value::Bytes(bytes),
                }
            }
            _ => return Err("EARTH_PROTOCOL: unsupported protobuf wire type".into()),
        };
        fields.push(Field { number, value });
    }
    Ok(fields)
}

pub fn int(fields: &[Field<'_>], n: u32) -> Option<u64> {
    fields.iter().rev().find_map(|f| match f.value {
        Value::Int(v) if f.number == n => Some(v),
        _ => None,
    })
}
pub fn bytes<'a>(fields: &[Field<'a>], n: u32) -> Option<&'a [u8]> {
    fields.iter().rev().find_map(|f| match f.value {
        Value::Bytes(v) if f.number == n => Some(v),
        _ => None,
    })
}
pub fn repeated<'a>(fields: &'a [Field<'a>], n: u32) -> impl Iterator<Item = &'a [u8]> {
    fields.iter().filter_map(move |f| match f.value {
        Value::Bytes(v) if f.number == n => Some(v),
        _ => None,
    })
}
pub fn doubles(data: &[u8]) -> Result<Vec<f64>> {
    if data.len() % 8 != 0 {
        return Err("EARTH_PROTOCOL: unaligned doubles".into());
    }
    let values: Vec<_> = data
        .chunks_exact(8)
        .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
        .collect();
    if values.iter().any(|v| !v.is_finite()) {
        return Err("EARTH_PROTOCOL: non-finite coordinates".into());
    }
    Ok(values)
}
pub fn floats(data: &[u8]) -> Result<Vec<f32>> {
    if data.len() % 4 != 0 {
        return Err("EARTH_PROTOCOL: unaligned floats".into());
    }
    let values: Vec<_> = data
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    if values.iter().any(|v| !v.is_finite()) {
        return Err("EARTH_PROTOCOL: non-finite floats".into());
    }
    Ok(values)
}
