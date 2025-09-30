import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import videoOptimization from "./video-optimization";
import { performanceMonitor } from "./performance-monitor";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Performance monitoring for sub-500ms validation
app.use(performanceMonitor.trackFirstByte);

// Video optimization middleware for instant loading
app.use(videoOptimization.optimizeVideoHeaders);

// HLS manifest endpoint for adaptive streaming
app.get('/media/optimized/:video.m3u8', (req, res) => {
  const videoName = req.params.video;
  const videoPath = `/media/optimized/${videoName}.mp4`;
  
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const manifest = videoOptimization.generateHLSManifest(videoPath);
  res.send(manifest);
});

// Enhanced streaming middleware with sub-500ms optimization
app.use((req, res, next) => {
  const videoExtensions = ['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v'];
  const streamingExtensions = ['.m3u8', '.mpd', '.ts', '.m4s'];
  
  const isVideo = videoExtensions.some(ext => req.path.toLowerCase().endsWith(ext));
  const isStreaming = streamingExtensions.some(ext => req.path.toLowerCase().endsWith(ext));
  
  if (isVideo || isStreaming) {
    const path = req.path.toLowerCase();
    const isHeroVideo = path.includes('intro') || path.includes('optimized');
    
    // First-byte optimization for hero video
    if (isHeroVideo && (path.includes('-000.mp4') || path.includes('init.mp4'))) {
      // Critical first segment - immediate response
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Priority', 'u=0, i'); // Highest HTTP/2 priority
      res.setHeader('X-Priority', 'critical');
    } else if (path.includes('.m3u8')) {
      // HLS manifests
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('Priority', 'u=1, i'); // High priority for manifests
    } else if (path.includes('.ts') || path.includes('-00')) {
      // Video segments
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      // Regular video files
      res.setHeader('Cache-Control', 'public, max-age=31536000');
    }
    
    // Enable byte-range requests
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // Content-Type mapping
    if (path.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
    } else if (path.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (path.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
    }
    
    // CORS and performance headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Accept-Encoding, Priority');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    
    // Disable buffering for streaming
    res.setHeader('X-Accel-Buffering', 'no');
  }
  
  next();
});

// Serve static files with optimized headers for instant video loading
app.use(express.static('public', {
  etag: true,
  lastModified: true,
  maxAge: 0, // Let middleware handle caching
  setHeaders: (res, path) => {
    const mediaExtensions = ['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v', '.3gp', '.flv', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
    const streamingExtensions = ['.m3u8', '.mpd', '.ts', '.m4s'];
    const isMedia = mediaExtensions.some(ext => path.toLowerCase().endsWith(ext));
    const isStreaming = streamingExtensions.some(ext => path.toLowerCase().endsWith(ext));
    
    if (isMedia || isStreaming) {
      // Enable aggressive caching and compression
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      
      // Preload hints for critical video resources
      if (path.includes('Intro.mp4') || path.includes('optimized')) {
        res.setHeader('X-Priority', 'high');
        res.setHeader('X-Preload', 'video');
      }
      
      // Video optimization flags
      res.setHeader('X-Video-Optimized', 'true');
    }
    
    // General performance headers
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
  }
}));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on port 5000
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = 5000;
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();
