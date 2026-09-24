/// A conservative identity for a shell command. Only simple directory and
/// environment setup may be normalized; other statements keep the full text.
pub fn command_execution_key(command: &str) -> String {
    let mut assignments = std::collections::BTreeMap::new();
    let mut directory = None;
    let mut invocation = None;
    let mut complex_invocation = false;
    for statement in command.split(['\n', ';']) {
        let words: Vec<&str> = statement.split_whitespace().collect();
        if words.is_empty() || words[0].starts_with('#') {
            continue;
        }
        if invocation.is_some() {
            return command.trim().to_owned();
        }
        if words[0] == "export" {
            if !collect_assignments(&words[1..], &mut assignments) {
                return command.trim().to_owned();
            }
            continue;
        }
        if words[0] == "cd" {
            if words.len() != 2 || statement.contains(['\'', '"', '\\']) {
                return command.trim().to_owned();
            }
            directory = Some(words[1]);
            continue;
        }
        let mut index = 0;
        if words[index] == "env" {
            index += 1;
        }
        while index < words.len() && words[index].contains('=') {
            if !collect_assignments(&words[index..index + 1], &mut assignments) {
                return command.trim().to_owned();
            }
            index += 1;
        }
        if words[0] == "env" && index == words.len() {
            return command.trim().to_owned();
        }
        if words.get(index) == Some(&"exec") {
            index += 1;
        }
        if index < words.len() {
            invocation = Some(words[index..].join(" "));
            complex_invocation =
                statement.contains(['\'', '"', '\\', '|', '&', '>', '<', '(', ')']);
        }
    }
    if complex_invocation {
        return command.trim().to_owned();
    }
    match invocation {
        Some(invocation) => format!("{directory:?}\0{assignments:?}\0{invocation}"),
        None => command.trim().to_owned(),
    }
}

fn collect_assignments<'a>(
    words: &[&'a str],
    assignments: &mut std::collections::BTreeMap<&'a str, &'a str>,
) -> bool {
    for word in words {
        let Some((name, value)) = word.split_once('=') else {
            return false;
        };
        if name.is_empty() || !name.chars().all(|c| c == '_' || c.is_ascii_alphanumeric()) {
            return false;
        }
        assignments.insert(name, value);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::command_execution_key;

    #[test]
    fn normalizes_only_simple_setup() {
        assert_eq!(
            command_execution_key("export A=1; B=2 job --fast"),
            command_execution_key("export A=1 B=2; job --fast")
        );
        assert_ne!(
            command_execution_key("echo first > out; job"),
            command_execution_key("echo second > out; job")
        );
        assert_ne!(
            command_execution_key("job one"),
            command_execution_key("job two")
        );
    }
}
