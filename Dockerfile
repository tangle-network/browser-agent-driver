# agent-driver — prebuilt sandbox image for LLM-driven browser automation
#
# Usage:
#   docker build -t agent-driver .
#   docker run -e OPENAI_API_KEY=sk-... agent-driver run --goal "Sign up" --url http://host.docker.internal:3000
#   docker run -v ./cases.json:/data/cases.json -v ./out:/output \
#     agent-driver run --cases /data/cases.json --sink /output/ --concurrency 4

FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# Install deps and build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Make CLI executable
RUN chmod +x dist/cli.js

# Default output directory (mount a volume here for persistence)
RUN mkdir -p /output
ENV AGENT_SINK_DIR=/output

# Run headless by default
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
