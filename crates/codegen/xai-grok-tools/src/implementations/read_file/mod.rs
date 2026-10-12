//! Shared image/metadata helpers for read tools (grok_build, etc.).

pub mod image;
pub mod metadata;

pub use metadata::{
    FileMetadata, bytes_to_metadata, extract_svg_text, should_embed_as_conversation_image,
};

pub use image::{CompressImageError, compress_image_for_conversation, image_read_output};
