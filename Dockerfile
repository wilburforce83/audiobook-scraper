# Use an official lightweight Node.js image
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy the rest of your application code
COPY . .

# Expose the port your app uses (this should match the settings.json value, e.g., 3000)
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]
