//! Layer-2 stream transforms: turn raw HTTP chunk streams into [`SamplingEvent`](crate::events::SamplingEvent) streams.
//!
//! Each backend has its own transform because the raw chunk types differ.
//! Dispatch lives in [`actor::request_task`](crate::actor::request_task), which reads `SamplerConfig.api_backend`.
//! It calls the matching `SamplingClient::conversation_stream*` method and hands the raw stream to the transform here.

pub mod chat_completions;
pub mod collect;
pub mod messages;
pub mod responses;
pub mod vendor_trailer;
mod xiaomi_chat;

pub use chat_completions::{stream_chat_completions, stream_chat_completions_with_adapter};
pub use collect::collect_response;
pub use messages::stream_messages;
pub use responses::stream_responses;
