# livecode — one static binary (deno compile) in a distroless image, uid 10001. Box contract rules 1–4, 12.
# Base images pinned by digest (Dependabot keeps them fresh, with a cooldown).

FROM denoland/deno:debian-2.9.8@sha256:a0d88a7fcbd44f062cba2748e19df67d30290ad12aa203c7c1e0b12462c483f0 AS build
WORKDIR /src
# Dependencies first (frozen lockfile, minimum age, no install scripts — see deno.json / .npmrc).
# The optional `ca` secret is only for builders behind a TLS-intercepting proxy; CI does not use it.
COPY deno.json deno.lock .npmrc ./
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export DENO_CERT=/run/secrets/ca; fi; deno ci
COPY . .
# The runtime `deno compile` wraps, pinned by checksum (instead of an unpinned download at compile time).
ADD --checksum=sha256:1577df68c9fe13ec7b974d10d483e9f8974575a3d17f7c127489cf5032e14bd4 \
    https://github.com/denoland/deno/releases/download/v2.9.8/denort-x86_64-unknown-linux-gnu.zip /tmp/denort.zip
RUN deno run --allow-read=/tmp --allow-write=/tmp scripts/unzip1.ts /tmp/denort.zip /tmp/denort
ENV DENORT_BIN=/tmp/denort
# Front-end bundle embedded into the server, then a single binary with its permissions compiled in.
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export DENO_CERT=/run/secrets/ca; fi; deno task build && deno task compile
RUN mkdir -p /out/data && chown 10001:10001 /out/data && chmod 700 /out/data

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="livecode" \
      org.opencontainers.image.description="Live-code an HTML/CSS/JS page together (code.hosh.it)" \
      org.opencontainers.image.source="https://github.com/pazka/livecode" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
COPY --from=build --chown=10001:10001 /out/data /data
COPY --from=build /src/dist/livecode /app/livecode
ENV APP_DATA_DIR=/data \
    LIVECODE_VERSION=${VERSION}
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/app/livecode", "healthcheck"]
ENTRYPOINT ["/app/livecode"]
CMD ["serve"]
