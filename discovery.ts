import { createSocket, RemoteInfo } from "node:dgram";
import EventEmitter from "node:events";
import mqtt, { MqttClient } from 'mqtt'; // Import mqtt

import { Commands } from "./datatypes.js";
import { create_LanSearch, parse_PunchPkt } from "./impl.js";
import { logger } from "./logger.js";
import { config } from "./settings.js";
import { DevSerial } from "./impl.js";

// Helper function to sanitize device ID for MQTT topics/unique IDs if needed
const sanitizeForMqtt = (id: string): string => {
    // Replace characters potentially problematic in MQTT topics or HA entity IDs
    return id.replace(/[\s+#\/]/g, '_');
};

const handleIncomingPunch = (msg: Buffer, ee: EventEmitter, rinfo: RemoteInfo) => {
    const ab = new Uint8Array(msg).buffer;
    const dv = new DataView(ab);
    const cmd_id = dv.readU16();
    if (cmd_id != Commands.PunchPkt) {
        return;
    }
    if (config.blacklisted_ips.indexOf(rinfo.address) !== -1) {
        logger.debug(`Dropping packet of blacklisted IP: ${rinfo.address}`);
        return;
    }
    logger.debug(`Received a PunchPkt message from ${rinfo.address}`);
    ee.emit("discover", rinfo, parse_PunchPkt(dv));
};

export const discoverDevices = (discovery_ips: string[]): EventEmitter => {
    const ee = new EventEmitter();
    let mqttClient: MqttClient | null = null;

    // --- START DEBUG CODE ---
    // Place this right at the top of your main script (e.g., bin.cjs)
    try {
        // Use console.log here in case logger isn't initialized yet
        console.log("--- Addon Environment Variables ---");
        console.log(JSON.stringify(process.env, null, 2));
        console.log("---------------------------------");
    } catch (e) {
        console.error("Error logging environment variables:", e);
    }
    // --- END DEBUG CODE ---

    // --- MQTT Client Setup ---
    const mqttHost = process.env.MQTT_HOST;
    const mqttPort = process.env.MQTT_PORT;
    const mqttUsername = process.env.MQTT_USERNAME;
    const mqttPassword = process.env.MQTT_PASSWORD;
    const mqttProtocol = process.env.MQTT_PROTOCOL || 'mqtt';

    if (!mqttHost || !mqttPort) {
        logger.info("MQTT configuration not found in environment variables. MQTT Discovery disabled. Ensure MQTT integration and Mosquitto broker addon are set up in Home Assistant.");
    } else {
        const brokerUrl = `${mqttProtocol}://${mqttHost}:${mqttPort}`;
        const options = {
            clientId: `cam_reverse_addon_${Math.random().toString(16).substring(2, 8)}`,
            username: mqttUsername,
            password: mqttPassword,
            clean: true, // Start with a clean session
            connectTimeout: 10000, // 10 seconds timeout
        };

        logger.info(`Attempting to connect to MQTT broker at ${brokerUrl}`);
        const client = mqtt.connect(brokerUrl, options);

        client.on('connect', () => {
            logger.info('Successfully connected to MQTT broker. MQTT Discovery enabled.');
            mqttClient = client; // Store the client instance
        });

        client.on('error', (error) => {
            logger.error(`MQTT Connection Error: ${error}. MQTT Discovery might not function.`);
            mqttClient = null; // Ensure client is null on error
        });

        client.on('close', () => {
            logger.info('MQTT connection closed.');
            // Optional: Implement reconnection logic if desired
            // mqttClient = null; // Commented out: keep client object for potential reconnects? Or nullify? Choose based on strategy. Let's nullify for simplicity now.
            mqttClient = null;
        });

        client.on('offline', () => {
            logger.info('MQTT client is offline.');
             mqttClient = null;
        });
    }
    // --- End MQTT Client Setup ---


    // --- UDP Discovery Setup ---
    const sock = createSocket("udp4");
    const SEND_PORT = 32108;
    let devicesDiscovered: Record<string, boolean> = {};
    let discoveryRunning = true;
    let discoveryInterval: NodeJS.Timeout | null = null;
    let discoveryTimeout: NodeJS.Timeout | null = null;

    sock.on("error", (err) => {
        logger.error(`UDP socket error:\n${err.stack}`);
        sock.close(); // Close socket on error
        // Consider emitting an error on ee or handling more gracefully
    });

    sock.on("message", (msg, rinfo) => handleIncomingPunch(msg, ee, rinfo));

    sock.on("listening", () => {
        const listenAddress = sock.address();
        logger.info(`UDP Discovery socket listening on ${listenAddress.address}:${listenAddress.port}`);
        let ls_buf = create_LanSearch();
        try {
            sock.setBroadcast(true); // Set broadcast after binding might be safer on some OS
        } catch (err) {
            logger.error(`Failed to set broadcast on socket: ${err.message}`);
            // Continue without broadcast if it fails? Depends on network requirements.
        }


        const sendLanSearch = () => {
            if (!discoveryRunning) {
                return;
            }
            discovery_ips.forEach((discovery_ip) => {
                logger.info("trace", `>> LanSearch [${discovery_ip}]`);
                // Ensure socket is not closed before sending
                if (sock && sock.address()) {
                     sock.send(new Uint8Array(ls_buf.buffer), SEND_PORT, discovery_ip, (err) => {
                        if (err) {
                             logger.error(`Error sending LanSearch to ${discovery_ip}: ${err.message}`);
                        }
                    });
                } else {
                    logger.info("UDP socket not ready or closed, skipping LanSearch send.");
                }
            });
        };

        discovery_ips.forEach((discovery_ip) => {
            logger.info(`Searching for devices via UDP on ${discovery_ip}:${SEND_PORT}`);
        });

        discoveryInterval = setInterval(sendLanSearch, 3000);
        sendLanSearch(); // Send immediately

        discoveryTimeout = setTimeout(() => {
            logger.info("Discovery process timeout reached (10 seconds). Stopping UDP search.");
            discoveryRunning = false;
            if (discoveryInterval) {
                clearInterval(discoveryInterval);
                discoveryInterval = null; // Clear interval ID
            }
            sock.close(); // Close the socket explicitly
        }, 10000); // Discovery runs for 10 seconds
    });

    // Bind the socket to listen for responses
    // Binding to 0.0.0.0 allows receiving packets from any interface
    try {
         sock.bind(undefined, "0.0.0.0", () => {
             logger.info("UDP Socket bound successfully.");
         });
    } catch(bindErr) {
        logger.error(`Failed to bind UDP socket: ${bindErr.message}`);
        ee.emit("error", new Error("Failed to bind UDP socket for discovery."));
        // Close MQTT client if it was initialized?
        mqttClient?.end();
        return ee; // Return emitter, but discovery won't work
    }


    const cleanup = () => {
        logger.info("Cleaning up discovery resources...");
        discoveryRunning = false; // Ensure loops stop
        if (discoveryInterval) {
            clearInterval(discoveryInterval);
            discoveryInterval = null;
        }
        if (discoveryTimeout) {
            clearTimeout(discoveryTimeout);
            discoveryTimeout = null;
        }
        // Attempt to close socket if it exists and hasn't been closed
        try {
            // Check if sock exists and has an address (means it was bound/listening)
             if (sock && sock.address()) {
                sock.close();
                 logger.info("UDP socket closed.");
             }
        } catch (closeErr) {
             logger.info(`Error closing UDP socket during cleanup: ${closeErr.message}`);
        }

        // Attempt to close MQTT client
        if (mqttClient) {
            logger.info("Closing MQTT client connection.");
            // Use end(true) for forceful close if needed, but regular end() is cleaner
            mqttClient.end(false, () => {
                 logger.info("MQTT client disconnected.");
            });
            mqttClient = null; // Clear reference
        }
    };

    // Handle socket close event
    sock.on("close", () => {
        logger.info("UDP Discovery socket closed.");
        // Clear timers just in case they are still referenced
         if (discoveryInterval) clearInterval(discoveryInterval);
         if (discoveryTimeout) clearTimeout(discoveryTimeout);
         discoveryInterval = null;
         discoveryTimeout = null;
         discoveryRunning = false; // Explicitly set running flag to false
        // Note: Don't call cleanup() here to avoid infinite loops if close triggers cleanup which closes sock again.
        // Consider if MQTT should be closed when UDP closes. Usually yes if discovery is the only purpose.
        // Let's close MQTT via ee.on("close") instead.
    });

    // Handle external close signal
    ee.on("close", () => {
        logger.info("Received close signal for discovery.");
        cleanup();
    });
    // --- End UDP Discovery Setup ---


    // --- Handle Discovered Device ---
    ee.on("discover", (rinfo: RemoteInfo, dev: DevSerial) => {
        const safeDevId = sanitizeForMqtt(dev.devId); // Sanitize the ID

        if (devicesDiscovered[safeDevId]) {
            logger.debug(`Camera ${safeDevId} (${dev.devId}) at ${rinfo.address} already processed, ignoring.`);
            return; // Already handled
        }

        devicesDiscovered[safeDevId] = true;
        logger.info(`Discovered new camera: ID=${safeDevId} (Original: ${dev.devId}) at ${rinfo.address}`);

        // Attempt MQTT Discovery if client is connected
        if (mqttClient && mqttClient.connected) {
            const deviceId = `cam_reverse_${safeDevId}`; // Unique ID for the HA device registry

            // Use addon slug 'nodejs_server' for DNS resolution within HA Docker network
            // Note: If host_network: true causes issues, might need host IP. Start with slug.
            const baseUrl = `http://nodejs_server:5000/camera/${dev.devId}`; // Use original devId for URL path

            const configTopic = `homeassistant/camera/${deviceId}/config`;
            const configPayload = {
                // Identification
                name: `CamReverse ${dev.devId}`, // User-friendly name
                unique_id: deviceId, // Unique ID for this camera entity

                // Platform specific config (MJPEG)
                topic: `homeassistant/camera/${deviceId}/state`, // Dummy state topic (optional but good practice)
                mjpeg_url: baseUrl,
                still_image_url: baseUrl, // Often the same URL works for still images

                // Linking to Device Registry
                device: {
                    identifiers: [deviceId], // Unique identifier for the device
                    name: `CamReverse Camera ${dev.devId}`,
                    manufacturer: "cam-reverse-addon",
                    model: "Reversed Stream",
                    // sw_version: "Your Addon Version", // Optional: Add addon version
                    // via_device: "cam-reverse-addon", // Optional: Link to the addon device itself if you create one
                },

                // Optional: Availability tracking (requires publishing to availability_topic)
                // availability_topic: `homeassistant/camera/${deviceId}/availability`,
                // payload_available: "online",
                // payload_not_available: "offline",

                // Other MQTT Camera options if needed (authentication, ssl etc.)
                // username: "",
                // password: "",
                // verify_ssl: false,

                // Ensure Home Assistant knows this is an MJPEG camera implicitly via URLs
                // No explicit "platform: mjpeg" needed in MQTT discovery payload
            };

            const payloadString = JSON.stringify(configPayload);

            logger.info(`Publishing MQTT discovery config for ${safeDevId} to topic ${configTopic}`);
            logger.debug(`Payload: ${payloadString}`);

            mqttClient.publish(configTopic, payloadString, { retain: true, qos: 0 }, (err) => {
                if (err) {
                    logger.error(`Failed to publish MQTT discovery for ${safeDevId}: ${err.message}`);
                } else {
                    logger.info(`Successfully published MQTT discovery for ${safeDevId}. Entity should appear in Home Assistant.`);
                    // You could optionally publish an initial "online" state here if using availability
                    // mqttClient.publish(`homeassistant/camera/${deviceId}/availability`, "online", { retain: true });
                    // And maybe an initial state
                    // mqttClient.publish(`homeassistant/camera/${deviceId}/state`, "idle", { retain: true });
                }
            });

        } else {
            // Fallback or log if MQTT is not available
            logger.info(`MQTT client not connected. Cannot register camera ${safeDevId} via MQTT Discovery.`);
            logger.info(`Manual configuration needed for camera ${dev.devId} at ${rinfo.address}:`);
            logger.info(`MJPEG URL:       http://<HOME_ASSISTANT_IP_OR_HOSTNAME>:5000/camera/${dev.devId}`); // Use HA address here for manual setup
            logger.info(`Still Image URL: http://<HOME_ASSISTANT_IP_OR_HOSTNAME>:5000/camera/${dev.devId}`);
            // Add other manual setup details if needed
        }
    });
    // --- End Handle Discovered Device ---

    return ee;
};

// Optional: Add function to explicitly stop discovery and cleanup
export const stopDiscovery = (ee: EventEmitter) => {
    ee.emit("close");
};
