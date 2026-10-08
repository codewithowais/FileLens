#!/usr/bin/env python3
"""
FileLens - Local Web Server
Provides high-performance HTTP serving with:
- Byte-range request support (Range: bytes=) for smooth video/audio seeking
- Correct MIME type mapping (.wasm, .mp4, .m4a, .wav, .js)
- Static file serving for public/ and samples/ directories
- CORS headers enabled
"""

import http.server
import mimetypes
import os
import re
import socketserver
import sys
import urllib.parse

PORT = 8000

# Base directories
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
SAMPLES_DIR = os.path.join(BASE_DIR, "samples")

# Additional MIME types
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("audio/wav", ".wav")
mimetypes.add_type("audio/mpeg", ".mp3")
mimetypes.add_type("application/json", ".json")


class FileLensHandler(http.server.BaseHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS and SharedArrayBuffer headers if needed
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path

        # Route matching
        if path == "/" or path == "/index.html":
            file_path = os.path.join(PUBLIC_DIR, "index.html")
        elif path.startswith("/samples/"):
            rel_path = path[len("/samples/"):]
            file_path = os.path.join(SAMPLES_DIR, rel_path)
        else:
            rel_path = path.lstrip("/")
            file_path = os.path.join(PUBLIC_DIR, rel_path)

        if not os.path.isfile(file_path):
            self.send_error(404, f"File not found: {path}")
            return

        self.serve_file(file_path)

    def serve_file(self, file_path):
        try:
            file_size = os.path.getsize(file_path)
            content_type, _ = mimetypes.guess_type(file_path)
            if not content_type:
                content_type = "application/octet-stream"

            range_header = self.headers.get("Range")

            if range_header:
                # Handle Byte-Range requests for seamless media scrubbing
                range_match = re.match(r"bytes=(\d+)-(\d*)", range_header)
                if range_match:
                    start = int(range_match.group(1))
                    end = int(range_match.group(2)) if range_match.group(2) else file_size - 1

                    if start >= file_size:
                        self.send_error(416, "Requested Range Not Satisfiable")
                        return

                    end = min(end, file_size - 1)
                    content_length = end - start + 1

                    self.send_response(206)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                    self.send_header("Content-Length", str(content_length))
                    self.send_header("Accept-Ranges", "bytes")
                    self.end_headers()

                    with open(file_path, "rb") as f:
                        f.seek(start)
                        self.wfile.write(f.read(content_length))
                    return

            # Normal full file response
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(file_size))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()

            with open(file_path, "rb") as f:
                self.wfile.write(f.read())

        except Exception as e:
            # Connection closed by client or I/O error
            pass


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def run(port=PORT):
    # Ensure samples exist
    if not os.path.exists(os.path.join(SAMPLES_DIR, "sample_interview_with_noise.wav")):
        print("Generating test multi-track samples...")
        import generate_samples
        generate_samples.main()

    server_address = ("127.0.0.1", port)
    try:
        httpd = ReusableTCPServer(server_address, FileLensHandler)
        print(f"\n=======================================================")
        print(f" FileLens Server Running!")
        print(f" URL: http://localhost:{port}")
        print(f" Mode: Web Audio 32-bit Float + STFT Component Separation")
        print(f"=======================================================\n")
        sys.stdout.flush()
        httpd.serve_forever()
    except OSError as e:
        if "Address already in use" in str(e):
            print(f"Port {port} is in use, attempting port {port + 1}...")
            run(port + 1)
        else:
            raise


if __name__ == "__main__":
    port_arg = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    run(port_arg)
