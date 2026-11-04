#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("{0}")]
    Other(String),

    /// Exit with a specific code. The message (when non-empty) is printed as the
    /// error; an empty one means the command already said everything.
    #[error("{1}")]
    Exit(i32, String),
}

impl Error {
    pub fn exit(code: i32, msg: impl Into<String>) -> Self {
        Error::Exit(code, msg.into())
    }

    /// The process exit code this error maps to.
    pub fn code(&self) -> i32 {
        match self {
            Error::Exit(c, _) => *c,
            _ => 1,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
