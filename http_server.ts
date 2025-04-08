// http_server.ts

import { RemoteInfo } from "dgram";
import http, { IncomingHttpHeaders, Server, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { URL } from 'node:url';
// Removed fs and path imports as we revert favicon loading

import { logger, buildLogger } from "./logger.js";
import { config } from "./settings.js";
import { discoverDevices, stopDiscovery } from "./discovery.js";
import { DevSerial } from "./impl.js";
import { Handlers, makeSession, Session, startVideoStream } from "./session.js";
import { addExifToJpeg, createExifOrientation } from "./exif.js";
import { initializeMqtt, getMqttClient, closeMqtt } from "./mqtt.js";
import { sendCameraDiscoveredNotification } from "./notifications.js";
import pkg from "./package.json";

// @ts-expect-error TS2307 - Assuming build process handles this import for favicon
import faviconGzData from "./cam.ico.gz";
// Removed html_template import

// --- Initialize Logger Early ---
buildLogger(process.env.ADDON_LOG_LEVEL || "info", undefined);

// --- Global State ---
const addonOptions = {
    mqttEnabled: process.env.ADDON_MQTT_ENABLED === 'true',
    uiPort: parseInt(process.env.ADDON_UI_PORT || '5000', 10),
    logLevel: process.env.ADDON_LOG_LEVEL || 'info',
};
if (isNaN(addonOptions.uiPort) || addonOptions.uiPort <= 0 || addonOptions.uiPort > 65535) {
    logger.error(`Invalid UI Port from env (${process.env.ADDON_UI_PORT}). Falling back to 5000.`);
    addonOptions.uiPort = 5000;
}
logger.info(`Addon Options Resolved: MQTT=${addonOptions.mqttEnabled}, Port=${addonOptions.uiPort}, LogLevel=${addonOptions.logLevel}`);
const inHass = !!process.env.SUPERVISOR_TOKEN;
logger.info(`Running inside Home Assistant environment: ${inHass}`);

const BOUNDARY = "cam-handler-boundary";
const responses: Record<string, ServerResponse[]> = {};
const audioResponses: Record<string, ServerResponse[]> = {};
const sessions: Record<string, Session> = {};
let activeDiscoveryEmitter: EventEmitter | null = null;
let httpServer: Server | null = null;

// --- Favicon Buffer (from import) ---
let faviconBuffer: Buffer | null = null;
try {
    // Assuming the import provides raw data (Buffer, Uint8Array, or Base64 string)
    if (typeof faviconGzData === 'string') {
        faviconBuffer = Buffer.from(faviconGzData, 'base64');
    } else if (faviconGzData instanceof Buffer || faviconGzData instanceof Uint8Array) {
         faviconBuffer = Buffer.from(faviconGzData);
    } else { throw new Error("Imported favicon data not recognized."); }
    logger.debug(`Favicon processed from import (${faviconBuffer.length} bytes).`);
} catch (favError) {
    logger.error(`Failed to process imported favicon: ${favError.message}`);
    faviconBuffer = null;
}

// EXIF Orientation constants
const oMap = [1, 8, 3, 6]; const oMapMirror = [2, 7, 4, 5];
const orientations = [1, 2, 3, 4, 5, 6, 7, 8].reduce((acc, cur) => ({ [cur]: createExifOrientation(cur), ...acc }), {});

// Helper for camera names (with safe access)
const cameraName = (id: string): string => config.cameras?.[id]?.alias || id;

// --- Centralized Discovery Event Handler ---
// Make sure this function exists and does the session creation/update
const handleDeviceDiscovered = (rinfo: RemoteInfo, dev: DevSerial) => {
  const safeDevId = dev.devId.replace(/[\s+#\/]/g, '_');
  if (sessions[safeDevId]) { logger.debug(`Camera ${safeDevId} already in session.`); return; }

  logger.info(`Handling newly discovered camera: ${safeDevId} at ${rinfo.address}`);
  responses[safeDevId] = []; audioResponses[safeDevId] = [];
  const s = makeSession(Handlers, dev, rinfo, startSessionCallback, 5000);
  sessions[safeDevId] = s; // Update global sessions

  // --- Config handling ---
  if (!config.cameras?.[safeDevId]) { config.cameras[safeDevId] = { rotate: 0, mirror: false, audio: true }; }
  else { config.cameras[safeDevId] = { rotate: 0, mirror: false, audio: true, ...config.cameras[safeDevId] }; }

  // --- Attach session listeners ---
  s.eventEmitter.on("frame", () => { /* ... frame handling ... */ });
  s.eventEmitter.on("disconnect", () => { /* ... disconnect handling ... */ });
  if (config.cameras?.[safeDevId]?.audio) { s.eventEmitter.on("audio", ({ data }) => { /* ... audio handling ... */ }); }

  // --- MQTT Discovery --- (Only if session is NEWLY created)
  if (inHass && addonOptions.mqttEnabled) {
       const mqttClient = getMqttClient();
       if (mqttClient?.connected) { /* ... MQTT publish logic ... */ }
       else { logger.error(`MQTT enabled but client not connected for ${safeDevId}.`); }
  } else if (inHass) { logger.debug(`MQTT disabled, skipping for ${safeDevId}.`); }
}; // End handleDeviceDiscovered

// --- Session Start Callback ---
const startSessionCallback = (s: Session) => {
  try { startVideoStream(s); logger.info(`Camera ${s.devName} session handshake complete, requested video stream.`); }
  catch (startError) { logger.error(`Error starting video stream for ${s.devName}: ${startError.message}`); s.close(); }
};

// --- Setup Discovery Listener Function --- (Ensure this function exists)
const setupDiscoveryListener = (emitter: EventEmitter) => {
  logger.debug("Attaching discovery listeners...");
  const discoveredThisRun: Record<string, boolean> = {}; // Track devices found in this specific run

  emitter.on("discover", (rinfo: RemoteInfo, dev: DevSerial) => {
       const safeDevId = dev.devId.replace(/[\s+#\/]/g, '_');

       // --- Send Notification ---
       // Only notify once *per discovery run* if in HA
       if (!discoveredThisRun[safeDevId] && inHass) {
           logger.info(`Attempting persistent notification for newly found ${safeDevId}`);
           sendCameraDiscoveredNotification(dev.devId, rinfo.address, addonOptions.uiPort)
              .catch(err => logger.error(`Notify error: ${err.message}`));
           discoveredThisRun[safeDevId] = true; // Mark as notified for this run
       }

       // --- Handle Session Creation/Update ---
       handleDeviceDiscovered(rinfo, dev); // Call the centralized handler
  });

  emitter.on("close", () => { logger.info("A discovery process finished."); if (emitter === activeDiscoveryEmitter) activeDiscoveryEmitter = null; });
  emitter.on("error", (err) => { logger.error(`Discovery emitter error: ${err.message}`); if (emitter === activeDiscoveryEmitter) activeDiscoveryEmitter = null; });
};

// --- Main HTTP Server Function ---
export const serveHttp = (port: number) => {
    if (inHass && addonOptions.mqttEnabled) { initializeMqtt(); }
    logger.info("Starting initial device discovery on server startup...");
    const initialDevEv = discoverDevices(config.discovery_ips);
    setupDiscoveryListener(initialDevEv); activeDiscoveryEmitter = initialDevEv;

    httpServer = http.createServer((req, res) => {
        const requestUrl = req.url || "/"; const method = req.method || "GET";
        const headers: IncomingHttpHeaders = req.headers;
        const clientIp = headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress;
        logger.info(`>>> Request Received: ${method} ${requestUrl} From: ${clientIp}`);
        logger.debug(`    Headers: ${JSON.stringify(headers, null, 2)}`);

        const ingressPath = inHass ? ((headers["x-ingress-path"] as string) || (headers["x-hassio-ingress-path"] as string) || "") : "";
        const basePath = ingressPath; const fullUrl = `http://${req.headers.host || 'localhost'}${requestUrl}`;
        const isIngressRequest = inHass && !!basePath
        logger.debug(`    Resolved Base Path: '${basePath}'`);

        try {
            // --- UI Detail Route ---
            if (requestUrl.startsWith("/ui/") || (basePath && requestUrl.startsWith(`${basePath}/ui/`))) {
                logger.debug(`Routing to /ui/ handler for ${requestUrl}`);
                const url = new URL(fullUrl); const devId = url.pathname.split("/")[basePath ? 5 : 2];
                const session = sessions[devId];
                if (!session) { res.writeHead(404); res.end("Session not found"); return; }
                if (!session.connected) { res.writeHead(503); res.end("Camera offline"); return; }
                const camData = config.cameras?.[devId];

                try {
                    res.setHeader("Content-Type", "text/html; charset=utf-8");
                    res.setHeader("Cache-Control", "no-store"); res.writeHead(200);
                    res.write(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">`);
                    res.write(`<title>Camera ${cameraName(devId)}</title>`);
                    res.write(`<link rel="shortcut icon" href="${basePath}/favicon.ico">`);
                    res.write(`<style>
                        body{font-family:sans-serif;margin:0;display:flex;flex-direction:column;align-items:center;padding:20px;background-color:#eee}
                        body.dark-mode{background-color:#222;color:#eee}
                        h1{margin-bottom:20px}
                        img#camera-stream{max-width:90vw;max-height:75vh;border:1px solid #888;background-color:#333}
                        .controls{margin-top:20px;display:flex;gap:15px}
                        button{font-size:1.5em;padding:10px 15px;cursor:pointer;border-radius:5px;border:1px solid #ccc}
                        body.dark-mode button{background-color:#555;color:#eee;border-color:#777}
                    </style></head>`);
                    res.write(`<body><h1>${cameraName(devId)} (${devId})</h1>`);
                    res.write(`<img id="camera-stream" src="${basePath}/camera/${devId}" alt="Live stream for ${devId}">`);
                    res.write(`<div class="controls"><button id="rotateBtn" title="Rotate">🔄</button><button id="mirrorBtn" title="Mirror">↔️</button></div>`);
                    res.write(`<script>
                        const devId="${devId}"; const basePath="${basePath}";
                        const rotateBtn=document.getElementById('rotateBtn'); const mirrorBtn=document.getElementById('mirrorBtn');
                        function applyDarkMode(){document.body.classList.toggle('dark-mode',localStorage.getItem('darkMode')==='true')} applyDarkMode();
                        rotateBtn?.addEventListener('click',()=>{fetch(\`\${basePath}/rotate/\${devId}\`).catch(e=>console.error('Rotate failed:',e))});
                        mirrorBtn?.addEventListener('click',()=>{fetch(\`\${basePath}/mirror/\${devId}\`).catch(e=>console.error('Mirror failed:',e))});
                     </script>`);
                    res.write(`</body></html>`); res.end(); logger.debug(`Rendered UI page for ${devId}`); return;
                } catch (uiRenderError) {
                     logger.error(`Error rendering UI page for ${devId}: ${uiRenderError.message}\n${uiRenderError.stack}`);
                     if (!res.writableEnded) { if (!res.headersSent) res.writeHead(500); res.end("Error rendering UI page"); } return;
                }
            }
            // --- Audio Route ---
            if ((isIngressRequest && requestUrl.startsWith(`${basePath}/audio/`)) || (!isIngressRequest && requestUrl.startsWith(`/audio/`))) {
              logger.debug(`Routing to /audio/ handler for ${requestUrl}`);
              const devId = requestUrl.split("/")[isIngressRequest ? 5 : 2]; const s = sessions[devId];
              if (!s) { res.writeHead(404); res.end("Invalid ID"); return; }
              if (!s.connected) { res.writeHead(503); res.end("Camera offline"); return; }
              res.setHeader("Content-Type", `text/event-stream`); res.setHeader("Cache-Control", "no-cache"); res.setHeader("Connection", "keep-alive"); res.writeHead(200);
              audioResponses[devId] = audioResponses[devId] || []; audioResponses[devId].push(res);
              logger.info(`Audio stream listener added for ${devId}. Count: ${audioResponses[devId].length}`);
              req.on('close', () => { logger.info(`Audio stream closed for ${devId}.`); audioResponses[devId] = audioResponses[devId]?.filter(r => r !== res) || []; }); return;
         }
         // --- Favicon Route ---
         if (requestUrl === `${basePath}/favicon.ico` || (!basePath && requestUrl ==='/favicon.ico')) {
              logger.debug(`Routing to /favicon.ico handler for ${requestUrl}`);
              if (faviconBuffer) { res.setHeader("Content-Type", "image/x-icon"); res.setHeader("Content-Encoding", "gzip"); res.writeHead(200); res.end(faviconBuffer); }
              else { res.writeHead(404); res.end("Favicon not found"); } return;
         }
         // --- Rotate/Mirror Routes ---
          if (requestUrl.startsWith(`${basePath}/rotate/`)) {
              logger.debug(`Routing to /rotate/ handler for ${requestUrl}`);
              const devId = requestUrl.split("/")[basePath ? 5 : 2];
              if (config.cameras?.[devId]) { let p = config.cameras[devId].rotate || 0; config.cameras[devId].rotate = (p + 1) % 4; logger.debug(`Rotated ${devId}`); res.writeHead(204); res.end(); }
              else { res.writeHead(404); res.end("Not Found"); } return;
          }
          if (requestUrl.startsWith(`${basePath}/mirror/`)) {
              logger.debug(`Routing to /mirror/ handler for ${requestUrl}`);
              const devId = requestUrl.split("/")[basePath ? 5 : 2];
              if (config.cameras?.[devId]) { config.cameras[devId].mirror = !config.cameras[devId].mirror; logger.debug(`Mirrored ${devId}`); res.writeHead(204); res.end(); }
              else { res.writeHead(404); res.end("Not Found"); } return;
          }
         // --- Camera Stream Route ---
          if ((isIngressRequest && requestUrl.startsWith(`${basePath}/camera/`)) || (!isIngressRequest && requestUrl.startsWith(`/camera/`))) {
              logger.debug(`Routing to /camera/ handler for ${requestUrl}`);
              const devId = requestUrl.split("/")[isIngressRequest ? 5 : 2]; const s = sessions[devId];
              if (!s) { logger.error(`Stream requested for unknown session: ${devId}`); res.writeHead(404); res.end("Camera not found"); return; }
              if (!s.connected) { logger.error(`Stream requested for offline session: ${devId}`); res.writeHead(503); res.end("Camera offline"); return; }
              res.setHeader("Content-Type", `multipart/x-mixed-replace; boundary="${BOUNDARY}"`); res.setHeader("Cache-Control", "no-store");
              res.setHeader("Pragma", "no-cache"); res.setHeader("Connection", "keep-alive"); res.writeHead(200); res.write(`\r\n--${BOUNDARY}\r\n`);
              responses[devId] = responses[devId] || []; responses[devId].push(res); logger.debug(`MJPEG stream listener added for ${devId}. Count: ${responses[devId].length}`);
              res.on("close", () => { logger.debug(`MJPEG stream closed for ${devId}.`); responses[devId] = responses[devId]?.filter((r) => r !== res) || []; });
              res.on("error", (err) => { logger.error(`MJPEG stream error for ${devId}: ${err.message}`); responses[devId] = responses[devId]?.filter((r) => r !== res) || []; }); return;
          }
            // --- Discover Trigger Route ---
            if (requestUrl === `${basePath}/discover` || (!basePath && requestUrl ==='/discover')) {
              logger.info("Discovery triggered via /discover endpoint.");
              if (activeDiscoveryEmitter) {
                  logger.error("Discovery already running."); res.writeHead(409, {"Content-Type": "application/json"}); res.end(JSON.stringify({ message: "Discovery already in progress." }));
              } else {
                  logger.info("Starting user-triggered device discovery...");
                  const triggeredDevEv = discoverDevices(config.discovery_ips); setupDiscoveryListener(triggeredDevEv); activeDiscoveryEmitter = triggeredDevEv;
                  res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify({ message: "Discovery process started." })); // Simple success message
              }
              return;
          }

            // --- Root Route (Main Page) ---
            if ( requestUrl === '/' || requestUrl === '//' || (basePath && requestUrl === basePath) || (basePath && requestUrl === `${basePath}/`) ) {
                logger.debug(`Routing to / (root) handler for request path: "${requestUrl}"`);
                try {
                    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
                    res.setHeader("Pragma", "no-cache"); res.setHeader("Expires", "0"); res.writeHead(200);

                    res.write(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">`);
                    res.write(`<link rel="shortcut icon" href="${basePath}/favicon.ico">`);
                    res.write(`<title>${inHass ? 'Camera Handler' : 'All Cameras'}</title>`);
                    // --- Full CSS ---
                    res.write(`<style>
                        body{font-family:Arial,sans-serif;margin:0;padding:0;background-color:#f4f4f4;color:#333;transition:background-color .3s,color .3s}
                        body::-webkit-scrollbar{background-color:#ffffff30;width:8px;border-radius:8px}
                        body::-webkit-scrollbar-track{background-color:#00000060;border-radius:8px}
                        body::-webkit-scrollbar-thumb{background-color:#555;border-radius:8px}
                        body::-webkit-scrollbar-button{display:none}
                        body.dark-mode{background-color:#121212;color:#f4f4f4}
                        header{display:flex;justify-content:space-between;align-items:center;padding:10px 20px;color:#fff;background-color:${inHass?"#18bcf2":"#0078d7"};position:sticky;top:0;z-index:10}
                        header.dark-mode{background-color:${inHass?"#18bcf2":"#005a9e"}}
                        header h1{margin:0;font-size:1.5em}
                        header button{background:0 0;border:none;color:#fff;font-size:20px;cursor:pointer;padding:5px;line-height:1}
                        header button:hover{opacity:.8}
                        .camera-container{padding:20px;display:flex;flex-direction:column;gap:15px}
                        .camera-container.grid-view{flex-direction:row;flex-wrap:wrap;gap:20px}
                        .camera-info,.camera-item{background-color:#fff;border:1px solid #ccc;border-radius:8px;padding:15px;box-shadow:0 1px 3px #0000001a}
                        .camera-info.dark-mode,.camera-item.dark-mode{background-color:#1e1e1e;border-color:#444}
                        .camera-item{display:flex;flex-direction:row;align-items:flex-start;text-decoration:none;color:inherit;transition:box-shadow .2s ease-in-out}
                        .camera-item:hover{box-shadow:0 4px 8px #00000026}
                        .camera-item.dark-mode:hover{box-shadow:0 4px 8px #0000004d}
                        .camera-item img{width:320px;height:240px;object-fit:cover;border-radius:4px;border:1px solid #ccc;display:block;background-color:#eee}
                        .camera-item.dark-mode img{background-color:#333;border-color:#555}
                        .camera-item .camera-details{margin-left:20px;border:none;padding:0;background:0 0;flex-grow:1}
                        .info-table{display:flex;flex-direction:column;gap:8px}
                        .info-table>div{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
                        .info-title{font-weight:700;min-width:50px}
                        code{font-size:.9em;border-radius:4px;padding:3px 6px;background-color:#eee;color:#333;border:1px solid #ccc;word-break:break-all}
                        .dark-mode code{background-color:#333;color:#eee;border-color:#555}
                        .copy-this{cursor:pointer;padding:3px 8px;font-size:1em;border:1px solid #ccc;border-radius:4px;background-color:#f0f0f0;line-height:1}
                        .dark-mode .copy-this{background-color:#444;border-color:#666;color:#eee}
                        .badge img{vertical-align:middle;height:1.2em}
                        .edit-friendly-name{background:0 0;border:none;color:inherit;font-size:1em;cursor:pointer;padding:0 5px;line-height:1}
                        .edit-friendly-name:hover{color:#0078d7}
                        .camera-container.grid-view .camera-item{flex-direction:column;max-width:350px;align-items:center}
                        .camera-container.grid-view .camera-item img{margin:0 auto 10px}
                        .camera-container.grid-view .camera-item .camera-details{margin-left:0;width:100%}
                        .camera-container.grid-view .camera-item .info-table{display:none}
                        .grid-name{display:none;text-align:center;font-weight:700;margin-top:10px}
                        .camera-container.grid-view .grid-name{display:block}
                        #instructions,#no-cameras{margin-bottom:10px}
                    </style></head>`);
                    res.write(`<body><header><h1>${inHass ? 'Camera Handler' : 'All Cameras'}</h1><div>
                          <button id="discoverDevices" title="Discover Devices">📡</button>
                          <button id="darkModeToggle" title="Toggle Dark Mode">💡</button>
                          ${!inHass ? '<button id="viewToggle" title="Toggle View">🖼️</button>' : ''}
                          </div></header><div class="camera-container" id="cameraContainer">`);
                    if (inHass) {
                        res.write(`<div class="camera-info" id="instructions">Click Discover (📡) above. For each camera found, copy the URL below (replace <code><HA_HOST_IP></code>) and click the badge <img src="https://my.home-assistant.io/badges/config_flow_start.svg" alt="MyHA Badge" style="height: 1.2em; vertical-align: middle;"> to add it manually via the MJPEG integration. <button onclick="window.location.reload()" style="margin-left: 10px; cursor: pointer;">Refresh List</button></div>`);
                        if (Object.keys(sessions).length === 0) { res.write(`<div class="camera-info" id="no-cameras">No cameras discovered yet. Click Discover.</div>`); }
                        else { Object.keys(sessions).forEach((id) => { const session = sessions[id]; const urlToCopy = `http://<HA_HOST_IP>:${addonOptions.uiPort}/camera/${id}`;
                                res.write(`<div class="camera-info" data-session-id="${id}"><div class="info-table"><div><span class="info-title">${cameraName(id)} (${id})</span><code>${urlToCopy}</code><button class="copy-this" title="Copy URL (replace <HA_HOST_IP>)" data-content="${urlToCopy}">📋</button><a href="/_my_redirect/config_flow_start?domain=mjpeg" class="my badge" target="_blank" title="Add MJPEG Camera Integration"><img src="https://my.home-assistant.io/badges/config_flow_start.svg" alt="Open MJPEG Config Flow"></a><span style="margin-left: auto; font-size: 0.9em;">(IP: ${session?.dst_ip || 'N/A'})</span></div></div></div>`); }); }
                    } else { // Standalone view
                         if (Object.keys(sessions).length === 0) { res.write(`<div class="camera-info" id="no-cameras">No cameras discovered yet. Click Discover.</div>`); }
                         else { Object.keys(sessions).forEach((id) => { const session = sessions[id]; const currentFriendlyName = cameraName(id);
                                res.write(`<a href="${basePath}/ui/${id}?friendlyName=${encodeURIComponent(currentFriendlyName)}" class="camera-item" data-id="${id}"><img src="${basePath}/camera/${id}" alt="Camera ${currentFriendlyName}" onerror="this.style.display='none'; this.onerror=null;"><div class="camera-details"><div class="info-table"><div><span class="info-title">ID:</span> ${id}</div><div><span class="info-title">Name:</span> ${currentFriendlyName}</div><div><span class="info-title">Label:</span> <span id="friendlyName_${id}">${currentFriendlyName}</span><button class="edit-friendly-name" data-id="${id}" title="Edit Label">✏️</button></div><div><span class="info-title">IP:</span> ${session?.dst_ip || 'N/A'}</div></div><div class="grid-name">${currentFriendlyName}</div></div></a>`); }); }
                    }
                    res.write(`</div>`); // Close cameraContainer
                    // --- Full Client-Side JS ---
                    res.write(`<script>
                        document.querySelectorAll('.copy-this').forEach(button=>{button.addEventListener('click',e=>{e.preventDefault();const t=button.getAttribute('data-content');navigator.clipboard.writeText(t).then(()=>{console.log('Copied: '+t);const e=button.textContent;button.textContent='✅',setTimeout(()=>{button.textContent=e},1500)}).catch(e=>{console.error('Copy failed: ',e)})})});
                        const basePath="${basePath}";const cameraContainer=document.getElementById('cameraContainer');const darkModeToggle=document.getElementById('darkModeToggle');
                        function applyDarkMode(e){document.body.classList.toggle('dark-mode',e),document.querySelector('header')?.classList.toggle('dark-mode',e),document.querySelectorAll('.camera-info, .camera-item').forEach(t=>t.classList.toggle('dark-mode',e))}
                        localStorage.getItem('darkMode')==='true'&&applyDarkMode(!0),darkModeToggle?.addEventListener('click',()=>{const e=document.body.classList.toggle('dark-mode');localStorage.setItem('darkMode',e),applyDarkMode(e)});
                        document.getElementById('discoverDevices')?.addEventListener('click',()=>{fetch(\`\${basePath}/discover\`).then(e=>e.ok?e.json():Promise.reject(new Error(\`HTTP \${e.status}\`))).then(e=>{console.log(e.message||'Discovery started. Refresh page after 10s to see results.')}).catch(e=>{console.error('Error triggering discovery:',e),alert(\`Failed to start discovery: \${e.message}\`)})});
                        const viewToggle=document.getElementById('viewToggle');viewToggle&&cameraContainer&&viewToggle.addEventListener('click',()=>cameraContainer.classList.toggle('grid-view'));
                        const inHass=${inHass};if(!inHass){const configCameras=${JSON.stringify(config.cameras||{})};function cameraName(e){return configCameras[e]?.alias||e}
                        document.querySelectorAll('.camera-item').forEach(item=>{const id=item.dataset.id;if(!id)return;const friendlyName=localStorage.getItem(\`friendlyName_\${id}\`)||cameraName(id);const nameSpan=document.getElementById(\`friendlyName_\${id}\`);nameSpan&&(nameSpan.innerText=friendlyName);const gridNameDiv=item.querySelector('.grid-name');gridNameDiv&&(gridNameDiv.textContent=friendlyName);const link=item.closest('a');link&&(link.href=\`\${basePath}/ui/\${id}?friendlyName=\${encodeURIComponent(friendlyName)}\`)});
                        document.querySelectorAll('.edit-friendly-name').forEach(button=>{button.addEventListener('click',e=>{e.preventDefault();const id=button.dataset.id;if(!id)return;const nameSpan=document.getElementById(\`friendlyName_\${id}\`);const currentName=nameSpan?nameSpan.innerText:cameraName(id);const newName=prompt('Enter new friendly name:',currentName);if(newName!==null&&newName.trim()!==''){localStorage.setItem(\`friendlyName_\${id}\`,newName),nameSpan&&(nameSpan.innerText=newName);const item=button.closest('.camera-item');if(!item)return;const gridNameDiv=item.querySelector('.grid-name');gridNameDiv&&(gridNameDiv.textContent=newName);const link=item.closest('a');link&&(link.href=\`\${basePath}/ui/\${id}?friendlyName=\${encodeURIComponent(newName)}\`);const nameDiv=item.querySelector('.info-table > div:nth-child(2)');nameDiv&&(nameDiv.childNodes[1].textContent=newName);const img=item.querySelector('img');img&&(img.alt=\`Camera \${newName}\`)}})})};
                      </script>`);
                    res.write(`</body></html>`); res.end(); logger.debug("Full root page rendered successfully."); return;
                } catch (renderError) { logger.error(`!!! Error rendering root page: ${renderError.message}\n${renderError.stack}`); if (!res.writableEnded) { if (!res.headersSent) res.writeHead(500); res.end("Internal Server Error during page render"); } return; }
            }
            // --- Fallback ---
            else { logger.error(`No route matched for: ${method} ${requestUrl}`); res.writeHead(404); res.end("Not Found"); }
        } catch (routeError) { logger.error(`!!! Top-level error handling route ${requestUrl}: ${routeError.message}\n${routeError.stack}`); if (!res.writableEnded) { if (!res.headersSent) res.writeHead(500); res.end("Internal Server Error"); } }
    });

    // --- Start Listening ---
    logger.info(`Camera Handler v${pkg.version} attempting to listen on port ${port}`);
    httpServer.listen(port, () => { logger.info(`Server is now actively listening on port ${port}`); });
    httpServer.on('error', (err) => { logger.error(`HTTP server error: ${err.message}`); process.exit(1); });

    // --- Graceful Shutdown ---
    process.on("SIGTERM", () => {
        logger.info("SIGTERM received. Shutting down...");
        if (activeDiscoveryEmitter) { logger.info("Stopping discovery..."); stopDiscovery(activeDiscoveryEmitter); activeDiscoveryEmitter = null; }
        if (inHass && addonOptions.mqttEnabled) { logger.info("Closing MQTT..."); closeMqtt(); }
        if (httpServer) {
            logger.info("Closing HTTP server...");
            httpServer.close(() => { logger.info("HTTP server closed."); process.exit(0); });
            setTimeout(() => { logger.error("Graceful shutdown timed out. Forcing exit."); process.exit(1); }, 5000);
        } else { process.exit(0); }
    });

}; // End serveHttp

// --- Auto-start if run directly (optional) ---
// Remove or guard this if bin.cjs is your main entry point
// serveHttp(addonOptions.uiPort);