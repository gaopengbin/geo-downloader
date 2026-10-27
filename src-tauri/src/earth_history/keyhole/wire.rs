//! Bounded proto2 reader, including correctly matched start/end group tags.
use super::super::{wire::varint, Result};
#[derive(Debug)]
pub enum Value<'a> {
    Int(u64),
    Bytes(&'a [u8]),
    Group(Vec<Field<'a>>),
    Fixed(u32),
    Other,
}
#[derive(Debug)]
pub struct Field<'a> {
    pub number: u32,
    pub value: Value<'a>,
}
pub fn parse(data: &[u8]) -> Result<Vec<Field<'_>>> {
    if data.len() > 32 * 1024 * 1024 {
        return Err("EARTH_BUDGET: legacy protobuf size".into());
    }
    let mut at = 0;
    let mut count = 0;
    read(data, &mut at, None, 0, &mut count)
}
fn read<'a>(
    data: &'a [u8],
    at: &mut usize,
    end: Option<u32>,
    depth: usize,
    count: &mut usize,
) -> Result<Vec<Field<'a>>> {
    if depth > 16 {
        return Err("EARTH_PROTOCOL: legacy group nesting".into());
    }
    let mut fields = Vec::new();
    while *at < data.len() {
        let key = varint(data, at)?;
        let n = u32::try_from(key >> 3).map_err(|_| "EARTH_PROTOCOL: field overflow")?;
        if n == 0 || n > 0x1fffffff {
            return Err("EARTH_PROTOCOL: legacy field number".into());
        }
        let wire = key & 7;
        if wire == 4 {
            return if end == Some(n) {
                Ok(fields)
            } else {
                Err("EARTH_PROTOCOL: mismatched end group".into())
            };
        }
        *count += 1;
        if *count > 100_000 {
            return Err("EARTH_BUDGET: legacy field count".into());
        }
        let value = match wire {
            0 => Value::Int(varint(data, at)?),
            3 => Value::Group(read(data, at, Some(n), depth + 1, count)?),
            1 | 2 | 5 => {
                let len = match wire {
                    1 => 8,
                    5 => 4,
                    _ => usize::try_from(varint(data, at)?)
                        .map_err(|_| "EARTH_PROTOCOL: legacy length")?,
                };
                let next = at
                    .checked_add(len)
                    .filter(|&v| v <= data.len())
                    .ok_or("EARTH_PROTOCOL: truncated legacy field")?;
                let bytes = &data[*at..next];
                *at = next;
                match wire {
                    2 => Value::Bytes(bytes),
                    5 => Value::Fixed(u32::from_le_bytes(bytes.try_into().unwrap())),
                    _ => Value::Other,
                }
            }
            _ => return Err("EARTH_PROTOCOL: legacy wire type".into()),
        };
        fields.push(Field { number: n, value });
    }
    if end.is_some() {
        return Err("EARTH_PROTOCOL: unterminated group".into());
    }
    Ok(fields)
}
pub fn int(fields: &[Field<'_>], n: u32) -> Option<u32> {
    fields.iter().rev().find_map(|f| match f.value {
        Value::Int(v) if f.number == n => u32::try_from(v).ok(),
        Value::Fixed(v) if f.number == n => Some(v),
        _ => None,
    })
}
pub fn bytes<'a>(fields: &[Field<'a>], n: u32) -> Option<&'a [u8]> {
    fields.iter().rev().find_map(|f| match f.value {
        Value::Bytes(v) if f.number == n => Some(v),
        _ => None,
    })
}
pub fn repeated<'a, 'b>(fields: &'b [Field<'a>], n: u32) -> impl Iterator<Item = &'a [u8]> + 'b {
    fields.iter().filter_map(move |f| match f.value {
        Value::Bytes(v) if f.number == n => Some(v),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn group_framing_is_not_a_length_delimited_message() {
        let f = parse(&[0x13, 0x18, 7, 0x22, 2, 0x08, 3, 0x14]).unwrap();
        let Value::Group(g) = &f[0].value else {
            panic!()
        };
        assert_eq!(int(g, 3), Some(7));
        assert_eq!(bytes(g, 4), Some(&[8, 3][..]));
        for bad in [
            &[0x13, 0x1c][..],
            &[0x13, 0x18, 7][..],
            &[0x14][..],
            &[0x0a, 10, 1][..],
        ] {
            assert!(parse(bad).is_err());
        }
    }
}
