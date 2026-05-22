# Stage 1: Build dependencies
FROM rust:1.85-slim AS planner
WORKDIR /app
RUN cargo new --bin backend
WORKDIR /app/backend
COPY Cargo.toml Cargo.lock ./
RUN cargo build --release
RUN rm src/*.rs

# Stage 2: Build application
COPY src ./src
# Touch main.rs to force rebuild with real source
RUN touch src/main.rs && cargo build --release

# Stage 3: Runtime
FROM debian:bookworm-slim
# Create a non-privileged app user
RUN groupadd -g 10001 appuser && \
    useradd -u 10001 -g appuser -s /sbin/nologin -c "Application User" appuser

WORKDIR /app
COPY --from=planner /app/backend/target/release/backend /app/backend

# Use non-root user
USER appuser:appuser

EXPOSE 3300
ENV PORT=3300
CMD ["/app/backend"]
