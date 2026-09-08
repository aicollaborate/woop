use std::io::{self, Read};

use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};

pub(super) const MAX_CONTENT_BYTES: usize = 64 * 1024 * 1024;
const ENGINE: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

struct NormalizedInput<'input>(&'input [u8]);

impl Read for NormalizedInput<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.0.len().min(buffer.len());
        for (target, source) in buffer[..count].iter_mut().zip(&self.0[..count]) {
            *target = match source {
                b'-' => b'+',
                b'_' => b'/',
                other => *other,
            };
        }
        self.0 = &self.0[count..];
        Ok(count)
    }
}

struct BoundedReader<Reader> {
    inner: Reader,
    remaining: usize,
}

impl<Reader: Read> Read for BoundedReader<Reader> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            return match self.inner.read(&mut [0_u8; 1])? {
                0 => Ok(0),
                _ => Err(too_large()),
            };
        }
        let count = buffer.len().min(self.remaining);
        let read = self.inner.read(&mut buffer[..count])?;
        self.remaining -= read;
        Ok(read)
    }
}

fn too_large() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "ATTACHMENT_CONTENT_TOO_LARGE")
}

pub(super) fn reader(input: &str) -> io::Result<impl Read + '_> {
    reader_with_limit(input, MAX_CONTENT_BYTES)
}

fn reader_with_limit(input: &str, limit: usize) -> io::Result<impl Read + '_> {
    if input.len() > limit.div_ceil(3).saturating_mul(4) {
        return Err(too_large());
    }
    Ok(BoundedReader {
        inner: base64::read::DecoderReader::new(NormalizedInput(input.as_bytes()), &ENGINE),
        remaining: limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_standard_and_url_safe_with_or_without_padding() {
        for input in ["+/8=", "-_8=", "+/8", "-_8"] {
            let mut output = Vec::new();
            reader_with_limit(input, 2)
                .unwrap()
                .read_to_end(&mut output)
                .unwrap();
            assert_eq!(output, [251, 255]);
        }
    }

    #[test]
    fn exact_limit_is_accepted_without_truncation() {
        let mut output = Vec::new();
        reader_with_limit("YWJj", 3)
            .unwrap()
            .read_to_end(&mut output)
            .unwrap();
        assert_eq!(output, b"abc");
    }

    #[test]
    fn decoded_limit_is_enforced_even_within_encoded_length_limit() {
        let mut output = Vec::new();
        let error = reader_with_limit("YWJj", 2)
            .unwrap()
            .read_to_end(&mut output)
            .unwrap_err();
        assert_eq!(error.to_string(), "ATTACHMENT_CONTENT_TOO_LARGE");
        assert!(output.len() <= 2);
    }

    #[test]
    fn oversized_encoding_is_rejected_before_decoding() {
        assert!(reader_with_limit("YWJjZA==", 3).is_err());
    }

    #[test]
    fn malformed_input_is_not_silently_accepted() {
        for input in ["a", "@@@@", "YQ==YQ==", "YW Jj"] {
            let mut output = Vec::new();
            assert!(reader_with_limit(input, 32)
                .unwrap()
                .read_to_end(&mut output)
                .is_err());
        }
    }

    #[test]
    fn empty_content_is_valid() {
        let mut output = Vec::new();
        reader_with_limit("", 0)
            .unwrap()
            .read_to_end(&mut output)
            .unwrap();
        assert!(output.is_empty());
    }
}
