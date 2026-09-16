//! What a scripted conversation answers one request with, in the format of the endpoint it arrived on.

use crate::failure::{CUT_REPLY, StatusFailure, StreamError};
use crate::inference_request::InferenceEndpoint;
use crate::scripted::ScriptedResponse;
use crate::sse::{chat_completion_script_exact, messages_api_script, responses_api_script_exact};
use crate::tool_call_turn::{
    ToolCallTurn, chat_completion_tool_call_events, cut_reply_events, looping_reply_events,
    messages_api_tool_use_events, responses_api_tool_call_events, stream_error_events,
};
use crate::tools::PickedToolCall;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ModelReply {
    ToolCall {
        call_id: String,
        call: PickedToolCall,
    },
    Text(String),
    /// The looping reply, with the detector's report when the request asked for it.
    LoopingReply {
        reported: bool,
    },
    Refusal(StatusFailure),
    StreamError(StreamError),
    CutReply,
    Dropped,
}

impl ModelReply {
    /// The answer in the endpoint's format; a plain reply stops with `end_turn` on Messages.
    pub(crate) fn into_response(
        self,
        endpoint: InferenceEndpoint,
        model: &str,
    ) -> ScriptedResponse {
        let events = match self {
            ModelReply::ToolCall { call_id, call } => {
                let arguments = call.arguments.to_string();
                let turn = ToolCallTurn {
                    call_id: &call_id,
                    name: &call.name,
                    arguments: &arguments,
                    model,
                };
                match endpoint {
                    InferenceEndpoint::ChatCompletions => chat_completion_tool_call_events(turn),
                    InferenceEndpoint::Responses => responses_api_tool_call_events(turn),
                    InferenceEndpoint::Messages => messages_api_tool_use_events(turn),
                }
            }
            ModelReply::Text(text) => match endpoint {
                InferenceEndpoint::ChatCompletions => chat_completion_script_exact(&text, model),
                InferenceEndpoint::Responses => responses_api_script_exact(&text, model),
                InferenceEndpoint::Messages => messages_api_script(&text, model, "end_turn"),
            },
            ModelReply::LoopingReply { reported } => {
                looping_reply_events(endpoint, model, reported)
            }
            ModelReply::StreamError(stream_error) => {
                stream_error_events(endpoint, &stream_error, model)
            }
            ModelReply::CutReply => cut_reply_events(endpoint, CUT_REPLY, model),
            ModelReply::Refusal(failure) => return failure.into_scripted_response(),
            ModelReply::Dropped => return ScriptedResponse::dropped(),
        };
        ScriptedResponse::sse(events)
    }
}

#[cfg(test)]
#[path = "model_reply_tests.rs"]
mod tests;
