---
'@fuzdev/fuz_app': minor
---

**breaking** fix: `bootstrap_account` compares the token with the token file's raw bytes less one optional trailing LF, the Rust spine's rule

- the file is no longer trimmed: a token file holding `tok\r\n`, `tok  \n`, two trailing newlines, or a leading newline now refuses `tok` with `invalid_token`; write the token exactly, with at most one trailing LF
