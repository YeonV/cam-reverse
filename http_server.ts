import { RemoteInfo } from "dgram";
import http from "node:http";

import { logger } from "./logger.js";
import { config } from "./settings.js";
import { discoverDevices } from "./discovery.js";
import { DevSerial } from "./impl.js";
import { Handlers, makeSession, Session, startVideoStream } from "./session.js";
import { addExifToJpeg, createExifOrientation } from "./exif.js";

// @ts-expect-error TS2307
import favicon from "./cam.ico.gz";
// @ts-expect-error TS2307
import html_template from "./asd.html";

const BOUNDARY = "a very good boundary line";
const responses: Record<string, http.ServerResponse[]> = {};
const audioResponses: Record<string, http.ServerResponse[]> = {};
const sessions: Record<string, Session> = {};

// https://sirv.com/help/articles/rotate-photos-to-be-upright/
const oMap = [1, 8, 3, 6];
const oMapMirror = [2, 7, 4, 5];
const orientations = [1, 2, 3, 4, 5, 6, 7, 8].reduce((acc, cur) => {
  return { [cur]: createExifOrientation(cur), ...acc };
}, {});

// Reads the mapping of serial numbers to camera names from the text file.

// Returns the camera name (custom name, if it exists, otherwise its ID).
const cameraName = (id: string): string => config.cameras[id].alias || id;

// The HTTP server.
export const serveHttp = (port: number) => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/ui/")) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const devId = url.pathname.split("/")[2];
      const session = sessions[devId];
    
      if (!session) {
        res.writeHead(400);
        res.end("Invalid ID");
        return;
      }
    
      if (!session.connected) {
        res.writeHead(400);
        res.end("Camera is offline");
        return;
      }
    
      const cameraData = config.cameras[devId];
      const ui = html_template
        .toString()
        .replace(/\${id}/g, devId)
        .replace(/\${name}/g, cameraName(devId))
        .replace(/\${audio}/g, cameraData.audio ? "true" : "false");
    
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(ui);
      return;
    }
    if (req.url.startsWith("/audio/")) {
      let devId = req.url.split("/")[2];
      let s = sessions[devId];
      if (s === undefined) {
        res.writeHead(400);
        res.end("invalid ID");
        return;
      }
      if (!s.connected) {
        res.writeHead(400);
        res.end("Nothing online");
        return;
      }
      res.setHeader("Content-Type", `text/event-stream`);
      audioResponses[devId].push(res);
      logger.info(`Audio stream requested for camera ${devId}`);
      return;
    }

    if (req.url.startsWith("/favicon.ico")) {
      res.setHeader("Content-Type", "image/x-icon");
      res.setHeader("Content-Encoding", "gzip");
      res.end(Buffer.from(favicon));
      return;
    }

    if (req.url.startsWith("/rotate/")) {
      let devId = req.url.split("/")[2];
      let curPos = config.cameras[devId]?.rotate || 0;
      let nextPos = (curPos + 1) % 4;
      logger.debug(`Rotating ${devId} to ${nextPos}`);
      config.cameras[devId].rotate = nextPos;
      res.writeHead(204);
      res.end();
      return;
    } else if (req.url.startsWith("/mirror/")) {
      let devId = req.url.split("/")[2];
      logger.debug(`Mirroring ${devId}`);
      config.cameras[devId].mirror = !config.cameras[devId].mirror;
      res.writeHead(204);
      res.end();
      return;
    } else if (req.url.startsWith("/camera/")) {
      let devId = req.url.split("/")[2];
      logger.info(`Video stream requested for camera ${devId}`);
      let s = sessions[devId];

      if (s === undefined) {
        res.writeHead(400);
        res.end(`Camera ${devId} not discovered`);
        return;
      }
      if (!s.connected) {
        res.writeHead(400);
        res.end(`Camera ${devId} offline`);
        return;
      }

      res.setHeader("Content-Type", `multipart/x-mixed-replace; boundary="${BOUNDARY}"`);
      responses[devId].push(res);
      res.on("close", () => {
        responses[devId] = responses[devId].filter((r) => r !== res);
        logger.info(`Video stream closed for camera ${devId}`);
      });
    } else if (req.url.startsWith("/discover")) {
      logger.info("Discovery triggered by client.");
      const devEv = discoverDevices(config.discovery_ips);
    
      devEv.on("discover", (rinfo: RemoteInfo, dev: DevSerial) => {
        logger.info(`Discovered camera ${dev.devId} at ${rinfo.address}`);
      });
    
      devEv.on("close", () => {
        logger.info("Discovery process completed.");
      });
    
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Discovery started for 10 seconds." }));
      return;
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write("<html>");
      res.write("<head>");
      res.write(`<link rel="shortcut icon" href="/favicon.ico">`);
      res.write("<title>All cameras</title>");
      res.write(`
        <style>
          /* General Styles */
          body {
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 0;
            background-color: #f4f4f4;
            color: #333;
            transition: background-color 0.3s, color 0.3s;          
          }
            body::-webkit-scrollbar {
            background-color: #ffffff30;
              width: 8px;
              border-radius: 8px;
            }

            body::-webkit-scrollbar-track {
              background-color: #00000060;
              border-radius: 8px;
            }

            body::-webkit-scrollbar-thumb {
              background-color: #555555;
              border-radius: 8px;
            }

            body::-webkit-scrollbar-button {
              display: none;
            }
          body.dark-mode {
            background-color: #121212;
            color: #f4f4f4;
          }
          header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 20px;
            background-color: #0078d7;
            color: white;
          }
          header.dark-mode {
            background-color: #005a9e;
          }
          header h1 {
            margin: 0;
          }
          header button {
            background: none;
            border: none;
            color: white;
            font-size: 16px;
            cursor: pointer;
          }
          header button:hover {
            text-decoration: underline;
          }

          /* Camera Container Styles */
          .camera-container {
            display: flex;
            flex-direction: column;
            gap: 20px;
            padding: 20px;
          }
          .camera-container.grid-view {
            flex-direction: row;
            flex-wrap: wrap;
          }

          /* Camera Item Styles */
          .camera-item {
            display: flex;
            flex-direction: row;
            align-items: center;
            border: 2px solid #ccc;
            border-radius: 8px;
            padding: 10px;
            background-color: white;
            transition: background-color 0.3s;
            box-sizing: border-box;
            text-decoration: none; /* Remove underline for links */
            color: inherit; /* Inherit text color */
          }
          .camera-item:hover {
            background-color: #f0f0f0; /* Add hover effect */
          }
          .camera-item img {
            max-width: 640px;
            max-height: 480px;
            border-radius: 8px;
            border: 1px solid #ccc;
          }
          .camera-item .camera-info {
            margin-left: 20px;
            display: flex;
            flex-direction: column;
            justify-content: center;
          }
          .camera-item .info-table {
            display: flex;
            flex-direction: column;
            gap: 5px;
          }
          .camera-item .info-table .info-title {
            display: inline-block;
            width: 80px; /* Fixed width for alignment */
            font-weight: bold;
          }
          .camera-item .grid-name {
            display: none; /* Hidden in list view */
            text-align: center;
            font-weight: bold;
            margin-top: 10px;
          }

          /* Grid View Adjustments */
          .camera-container.grid-view .camera-item {
            flex-direction: column;
            max-width: 666px; /* Updated max-width */
          }
          .camera-container.grid-view .camera-item img {
            margin: 0 auto;
          }
          .camera-container.grid-view .camera-item .info-table {
            display: none; /* Hide detailed info in grid view */
          }
          .camera-container.grid-view .camera-item .grid-name {
            display: block; /* Show camera name in grid view */
          }

          /* Dark Mode for Camera Items */
          .camera-item.dark-mode {
            background-color: #1e1e1e;
            border-color: #444;
          }
          .edit-friendly-name {
            background: none;
            border: none;
            color: inherit;
            font-size: 16px;
            cursor: pointer;
            transform: scale(-1, 1);
          }
          .edit-friendly-name:hover {
            color: #0078d7;
          }
          #darkModeToggle, #viewToggle {
              filter: brightness(100);
              text-decoration: none; 
          }
        </style>
      `);
      res.write("</head>");
      res.write("<body>");
      res.write(`
        <header>
          <h1>All Cameras</h1>
          <div>
            <button id="discoverDevices">&#128472;</button>
            <button id="darkModeToggle">&#128261;</button>
            <button id="viewToggle">&#8862;</button>
          </div>
        </header>
        <div class="camera-container" id="cameraContainer">
      `);

      // Dynamically generate camera items
      Object.keys(sessions).forEach((id) => {
        const session = sessions[id];
        const cameraData = config.cameras[id];
        res.write(`
          <a href="/ui/${id}?friendlyName=" class="camera-item" data-id="${id}">
            <img src="/camera/${id}" alt="Camera ${cameraName(id)}">
            <div class="camera-info">
              <div class="info-table">
                <div><span class="info-title">ID:</span> ${id}</div>
                <div><span class="info-title">Name:</span> ${cameraName(id)}</div>
                <div><span class="info-title">Label:</span> <span id="friendlyName_${id}">${id}</span><button class="edit-friendly-name" data-id="${id}">&#x270E;</button></div>
                <div><span class="info-title">IP:</span> ${session.dst_ip}</div>
                
              </div>
              <div class="grid-name" data-id="${id}">${cameraName(id)}</div>
            </div>
          </a>
        `);
      });

      res.write(`
        </div>
        <script>
          // Load Friendly Names from localStorage
          document.querySelectorAll('.camera-item').forEach(item => {
            const id = item.dataset.id;
            const friendlyName = localStorage.getItem(\`friendlyName_\${id}\`) || id;
            document.getElementById(\`friendlyName_\${id}\`).innerText = friendlyName;
            document.querySelector(\`.grid-name[data-id="\${id}"]\`).innerText = friendlyName;

            // Update the href to include the friendlyName as a URL parameter
            item.href = \`/ui/\${id}?friendlyName=\${encodeURIComponent(friendlyName)}\`;
          });

          // Edit Friendly Name
          document.querySelectorAll('.edit-friendly-name').forEach(button => {
            button.addEventListener('click', () => {
              const id = button.dataset.id;
              const currentName = localStorage.getItem(\`friendlyName_\${id}\`) || id;
              const newName = prompt('Enter a new friendly name:', currentName);
              if (newName !== null) {
                localStorage.setItem(\`friendlyName_\${id}\`, newName);
                document.getElementById(\`friendlyName_\${id}\`).innerText = newName;
                document.querySelector(\`.grid-name[data-id="\${id}"]\`).innerText = newName;

                // Update the href to include the new friendlyName
                document.querySelector(\`.camera-item[data-id="\${id}"]\`).href = \`/ui/\${id}?friendlyName=\${encodeURIComponent(newName)}\`;
              }
            });
          });

          // Load Dark Mode Setting
          if (localStorage.getItem('darkMode') === 'true') {
            document.body.classList.add('dark-mode');
            document.querySelector('header').classList.add('dark-mode');
            document.querySelectorAll('.camera-item').forEach(item => {
              item.classList.add('dark-mode');
            });
          }

            // Discover Devices Button
          const discoverDevicesButton = document.getElementById('discoverDevices');
          discoverDevicesButton.addEventListener('click', () => {
            fetch('/discover')
              .then(response => response.json())
              .then(data => {
                alert(data.message); // Notify the user that discovery has started
              })
              .catch(err => {
                console.error('Error triggering discovery:', err);
                alert('Failed to start discovery.');
              });
          });

          // Dark Mode Toggle
          const darkModeToggle = document.getElementById('darkModeToggle');
          darkModeToggle.addEventListener('click', () => {
            const isDarkMode = document.body.classList.toggle('dark-mode');
            document.querySelector('header').classList.toggle('dark-mode');
            document.querySelectorAll('.camera-item').forEach(item => {
              item.classList.toggle('dark-mode');
            });
            localStorage.setItem('darkMode', isDarkMode); // Save setting
          });

          // Grid/List View Toggle
          const viewToggle = document.getElementById('viewToggle');
          const cameraContainer = document.getElementById('cameraContainer');
          viewToggle.addEventListener('click', () => {
            cameraContainer.classList.toggle('grid-view');
          });
        </script>
      `);

      res.write("</body>");
      res.write("</html>");
      res.end();
    }
  });

  let devEv = discoverDevices(config.discovery_ips);

  const startSession = (s: Session) => {
    startVideoStream(s);
    logger.info(`Camera ${s.devName} is now ready to stream`);
  };

  devEv.on("discover", (rinfo: RemoteInfo, dev: DevSerial) => {
    if (dev.devId in sessions) {
      logger.info(`Camera ${dev.devId} at ${rinfo.address} already discovered, ignoring`);
      return;
    }

    logger.info(`Discovered camera ${dev.devId} at ${rinfo.address}`);
    responses[dev.devId] = [];
    audioResponses[dev.devId] = [];
    const s = makeSession(Handlers, dev, rinfo, startSession, 5000);
    sessions[dev.devId] = s;
    config.cameras[dev.devId] = { rotate: 0, mirror: false, audio: true, ...(config.cameras[dev.devId] || {}) };

    s.eventEmitter.on("frame", () => {
      // Add an EXIF header to indicate if the image should be rotated or mirrored
      let orientation = config.cameras[dev.devId].rotate;
      orientation = config.cameras[dev.devId].mirror ? oMapMirror[orientation] : oMap[orientation];
      const exifSegment = orientations[orientation];
      const jpegHeader = addExifToJpeg(s.curImage[0], exifSegment);
      const assembled = Buffer.concat([jpegHeader, ...s.curImage.slice(1)]);
      const header = Buffer.from(`\r\n--${BOUNDARY}\r\nContent-Length: ${assembled.length}\r\nContent-Type: image/jpeg\r\n\r\n`);
      responses[dev.devId].forEach((res) => {
          res.write(header);
          res.write(assembled);
      });
  });

    s.eventEmitter.on("disconnect", () => {
      logger.info(`Camera ${dev.devId} disconnected`);
      delete sessions[dev.devId];
    });
    if (config.cameras[dev.devId].audio) {
      s.eventEmitter.on("audio", ({ gap, data }) => {
        // ew, maybe WS?
        var b64encoded = Buffer.from(data).toString("base64");
        audioResponses[dev.devId].forEach((res) => {
          res.write("data: ");
          res.write(b64encoded);
          res.write("\n\n");
        });
      });
    }
  });

  logger.info(`Starting HTTP server on port ${port}`);
  server.listen(port);
};
