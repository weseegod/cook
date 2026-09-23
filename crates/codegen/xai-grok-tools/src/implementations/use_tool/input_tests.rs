use super::*;
use serde_json::json;

#[test]
fn all_known_field_presence_combinations_are_exclusive() {
    for mask in 0..16 {
        let mut object = serde_json::Map::new();
        for (index, key) in FIELDS.iter().enumerate() {
            if mask & (1 << index) != 0 {
                object.insert(
                    (*key).to_owned(),
                    match *key {
                        "tool_input" => Value::Null,
                        _ => json!("x"),
                    },
                );
            }
        }
        object.insert("unrelated".to_owned(), json!(true));
        let result = serde_json::from_value::<UseToolInput>(Value::Object(object));
        if [3, 5, 8].contains(&mask) {
            let parsed = result.unwrap();
            assert_eq!(
                parsed,
                serde_json::from_value(serde_json::to_value(&parsed).unwrap()).unwrap()
            );
        } else {
            assert!(
                result.unwrap_err().to_string().contains("exactly one"),
                "mask {mask}"
            );
        }
    }
}

#[test]
fn raw_duplicate_and_escaped_equivalent_keys_reject_before_mapping() {
    let mapping = HashMap::from([
        ("target".to_owned(), "tool_name".to_owned()),
        ("source".to_owned(), "file".to_owned()),
    ]);
    for json in [
        r#"{"file":"a","file":"b"}"#,
        r#"{"file":"a","f\u0069le":"b"}"#,
        r#"{"file":"a","source":"b"}"#,
        r#"{"target":"a","tool_name":"b","tool_input":{}}"#,
    ] {
        assert!(
            UseToolInput::from_model_json(json, &mapping)
                .unwrap_err()
                .to_string()
                .contains("duplicate or ambiguous")
        );
    }
}

#[test]
fn paths_and_inline_values_keep_legacy_semantics() {
    for value in [
        Value::Null,
        json!("{\"n\":1}"),
        json!(7),
        json!([]),
        json!({}),
    ] {
        let parsed: UseToolInput =
            serde_json::from_value(json!({"tool_name":"server__tool","tool_input":value})).unwrap();
        assert_eq!(
            UseToolInput::Inline(InlineMcpInvocation {
                tool_name: "server__tool".to_owned(),
                tool_input: value
            }),
            parsed
        );
    }
    for path in [Value::Null, json!(""), json!(7)] {
        assert!(
            serde_json::from_value::<UseToolInput>(json!({"file":path}))
                .unwrap_err()
                .to_string()
                .contains("nonempty string")
        );
    }
    let input: UseToolInput =
        serde_json::from_value(json!({"file":" ../unchanged path "})).unwrap();
    assert_eq!(Some(Path::new(" ../unchanged path ")), input.source_path());
}

#[test]
fn file_documents_are_strict_canonical_and_nonrecursive() {
    for document in [
        "{}",
        "null",
        "[]",
        "{} {}",
        r#"{"tool_name":"s__t","tool_input":null}"#,
        r#"{"tool_name":"s__t","tool_input":"{}"}"#,
        r#"{"tool_name":"s__t","tool_input":{},"file":null}"#,
        r#"{"tool_name":"s__t","tool_input":{},"tool_input_file":null}"#,
        r#"{"target":"s__t","args":{}}"#,
        r#"{"tool_name":"s__t","tool_name":"s__u","tool_input":{}}"#,
    ] {
        assert!(
            UseToolInput::from_invocation_file(document).is_err(),
            "{document}"
        );
    }
    let remote = json!({"file":"ordinary data", "tool_name":"not a target", "tool_input_file":"also data", "input": "{\"body\":\"exact\\ntext\"}"});
    assert_eq!(remote, parse_arguments_file(&remote.to_string()).unwrap());
    let input = UseToolInput::from_invocation_file(
        &json!({"tool_name":"s__t","tool_input":remote}).to_string(),
    )
    .unwrap();
    assert_eq!(remote, input.tool_input);
    for document in ["null", "[]", "\"{}\"", "{} trailing", ""] {
        assert!(parse_arguments_file(document).is_err(), "{document}");
    }
    assert_eq!(json!({}), parse_arguments_file("{}").unwrap());
}

#[test]
fn remapping_does_not_descend_into_remote_properties() {
    let mapping = HashMap::from([
        ("file".to_owned(), "source".to_owned()),
        ("tool_input".to_owned(), "args".to_owned()),
    ]);
    let nested = json!({"properties":{"tool_input":{"properties":{"file":{"type":"string"}},"required":["file"]}},"required":["tool_input"]});
    let mapped = crate::util::remap::remap_schema_properties(&nested, &mapping);
    assert_eq!(
        nested.get("properties").unwrap().get("tool_input"),
        mapped.pointer("/properties/args")
    );
}

/// Empty `{}` must fail with the inline fill-in example, not only the form-list error.
/// Real-model `agents.mcp_echo` kept retrying `{}` after the schema description alone.
#[test]
fn empty_object_error_includes_inline_fill_in_example() {
    let err = serde_json::from_value::<UseToolInput>(Value::Object(
        serde_json::Map::new(),
    ))
    .unwrap_err()
    .to_string();
    assert!(
        err.contains("exactly one"),
        "must keep form-list guidance: {err}"
    );
    assert!(
        err.contains("empty {} is invalid"),
        "must call out empty object: {err}"
    );
    assert!(
        err.contains(r#"{"tool_name": "<discovered name>", "tool_input": {"<param>": <value>}}"#),
        "must show required inline form: {err}"
    );
    assert!(
        err.contains(r#"{"tool_name": "echo__echo", "tool_input": {"text": "hello"}}"#),
        "must show concrete example: {err}"
    );
}

/// Non-empty wrong-key objects keep the short form-list error (no empty-specific noise).
#[test]
fn non_empty_wrong_keys_keep_short_form_list_error() {
    let err = serde_json::from_value::<UseToolInput>(json!({"unrelated": true}))
        .unwrap_err()
        .to_string();
    assert!(err.contains("exactly one"), "{err}");
    assert!(
        !err.contains("empty {} is invalid"),
        "short error for non-empty wrong keys: {err}"
    );
}

/// File-input schema must carry top-level `required` for the preferred inline pair so
/// weak models stop emitting `{}` (real-model agents.mcp_echo), plus the never-empty
/// example on the root description.
#[test]
fn file_input_schema_root_description_forbids_empty_object() {
    let schema = serde_json::to_value(UseToolInput::input_schema(true)).unwrap();
    assert_eq!(
        schema.get("required"),
        Some(&serde_json::json!(["tool_name", "tool_input"])),
        "file-input root must require the preferred inline pair: {schema}"
    );
    let description = schema
        .get("description")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| panic!("file-input schema missing root description: {schema}"));
    assert!(
        description.contains("never empty {}") || description.contains("never empty `{}`"),
        "root description must forbid empty object: {description}"
    );
    assert!(
        description.contains(r#"{"tool_name": "<discovered name>", "tool_input": {"<param>": <value>}}"#),
        "root description must show required inline form: {description}"
    );
    assert!(
        description.contains(r#"{"tool_name": "echo__echo", "tool_input": {"text": "hello"}}"#),
        "root description must show concrete example: {description}"
    );
    // Non-file schema keeps the simple required pair and does not need the union description.
    let inline = serde_json::to_value(UseToolInput::input_schema(false)).unwrap();
    assert_eq!(
        inline.get("required"),
        Some(&serde_json::json!(["tool_name", "tool_input"]))
    );
}
