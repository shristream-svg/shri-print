# SHRI Print - Multi-stage Docker build
# Stage 1: Build dependencies
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --ignore-scripts

# Copy source code
COPY . .

# Generate database schema
RUN npm run db:generate

# Build application
RUN npm run build

# Stage 2: Production runtime
FROM node:22-alpine AS runtime

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache \
    tini \
    su-exec \
    poppler-utils \
    ghostscript

# Create non-root user
RUN addgroup -g 1000 -S shriprint && \
    adduser -u 1000 -S shriprint -G shriprint

# Copy built application
COPY --from=builder --chown=shriprint:shriprint /app/dist ./dist
COPY --from=builder --chown=shriprint:shriprint /app/worker ./worker
COPY --from=builder --chown=shriprint:shriprint /app/lib ./lib
COPY --from=builder --chown=shriprint:shriprint /app/local ./local
COPY --from=builder --chown=shriprint:shriprint /app/agent ./agent
COPY --from=builder --chown=shriprint:shriprint /app/scripts ./scripts
COPY --from=builder --chown=shriprint:shriprint /app/db ./db
COPY --from=builder --chown=shriprint:shriprint /app/package*.json ./
COPY --from=builder --chown=shriprint:shriprint /app/tsconfig.json ./

# Create runtime directories
RUN mkdir -p runtime/agent-cache runtime/db && \
    chown -R shriprint:shriprint runtime

# Switch to non-root user
USER shriprint

# Expose ports
EXPOSE 4888

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4888/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Default command
CMD ["node", "local/server.mjs"]