# Stage 1: Get Java 21 from the official Eclipse Temurin image
FROM eclipse-temurin:21-jdk AS java_base

# Stage 2: Main application image
FROM node:20-slim

# Install necessary runtime libraries for Java
RUN apt-get update && \
    apt-get install -y --no-install-recommends libatomic1 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy Java from the first stage
COPY --from=java_base /opt/java/openjdk /opt/java/openjdk

# Set environment variables for Java
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Set the working directory to the app root inside the container
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy the source code
COPY . .

# Create the temp directory for compilation storage inside the backend folder
RUN mkdir -p temp && chmod 777 temp

# Set a Cloud Run friendly default port while still honoring runtime overrides
ENV PORT=8080
ENV NODE_ENV=production

# Expose the Cloud Run default port
EXPOSE 8080

# Start the application from the backend directory
CMD ["node", "server.js"]
