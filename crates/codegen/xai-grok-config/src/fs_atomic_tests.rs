use super::*;

#[test]
fn write_atomically_replaces_and_if_absent_refuses() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("marker");

    write_atomically_if_absent(&path, "first", None).expect("nothing there yet");
    let err = write_atomically_if_absent(&path, "second", None).expect_err("target exists");
    assert_eq!(std::io::ErrorKind::AlreadyExists, err.kind());
    assert_eq!("first", std::fs::read_to_string(&path).expect("read"));

    write_atomically(&path, "third", None).expect("rename replaces");
    assert_eq!("third", std::fs::read_to_string(&path).expect("read"));
    assert_eq!(
        1,
        std::fs::read_dir(dir.path()).expect("dir").count(),
        "no temp file left behind"
    );
}

/// Every racing first writer learns the same outcome: one wins, the file holds that writer's bytes,
/// and every loser sees `AlreadyExists` rather than silently replacing the winner.
#[test]
fn concurrent_first_writers_agree_on_one_winner() {
    for _ in 0..20 {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("marker");
        let barrier = std::sync::Barrier::new(4);
        let results: Vec<Result<(), std::io::ErrorKind>> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|i| {
                    let (path, barrier) = (&path, &barrier);
                    scope.spawn(move || {
                        barrier.wait();
                        write_atomically_if_absent(path, &format!("writer {i}"), None)
                            .map_err(|e| e.kind())
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().expect("thread"))
                .collect()
        });
        let winners: Vec<usize> = results
            .iter()
            .enumerate()
            .filter_map(|(i, r)| r.is_ok().then_some(i))
            .collect();
        let [winner] = winners[..] else {
            panic!("exactly one writer must win: {results:?}");
        };
        assert!(
            results
                .iter()
                .all(|r| matches!(r, Ok(()) | Err(std::io::ErrorKind::AlreadyExists))),
            "{results:?}"
        );
        assert_eq!(
            format!("writer {winner}"),
            std::fs::read_to_string(&path).expect("read")
        );
        assert_eq!(1, std::fs::read_dir(dir.path()).expect("dir").count());
    }
}
