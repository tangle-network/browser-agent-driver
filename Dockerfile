# bad — prebuilt sandbox image for LLM-driven browser automation
#
# Usage:
#   docker build -t bad .
#   docker run -e OPENAI_API_KEY=sk-... bad run --goal "Sign up" --url http://host.docker.internal:3000
#   docker run -v ./cases.json:/data/cases.json -v ./out:/output \
#     bad run --cases /data/cases.json --sink /output/ --concurrency 4

FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# The repo standardizes on pnpm: every CI workflow runs `pnpm install
# --frozen-lockfile` and pnpm-lock.yaml is the single source of truth (there is
# no committed npm lockfile). Enable pnpm in the image to match.
RUN npm install -g pnpm@10.33.3

# Install deps and build. scripts/ is copied before install because the root
# postinstall (provider patches) reads from it, and the build step does too.
COPY package.json pnpm-lock.yaml ./
COPY scripts/ ./scripts/
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build

# Make CLI executable
RUN chmod +x dist/cli.js

# Default output directory (mount a volume here for persistence)
RUN mkdir -p /output
ENV AGENT_SINK_DIR=/output

# Run headless by default
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
