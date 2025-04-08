import { createSocket, RemoteInfo } from "node:dgram";
import EventEmitter from "node:events";

import { Commands } from "./datatypes.js";
import { create_LanSearch, parse_PunchPkt, DevSerial } from "./impl.js"; // Ensure DevSerial is exported from impl
import { logger } from "./logger.js";
import { config } from "./settings.js"; // Keep for blacklisted_ips

// Function to parse incoming discovery responses
const handleIncomingPunch = (msg: Buffer, ee: EventEmitter, rinfo: RemoteInfo) => {
    const ab = new Uint8Array(msg).buffer;
    const dv = new DataView(ab);
    const cmd_id = dv.readU16();

    if (cmd_id !== Commands.PunchPkt) {
        return; // Ignore non-PunchPkt messages
    }

    if (config.blacklisted_ips.includes(rinfo.address)) {
        logger.debug(`Dropping PunchPkt from blacklisted IP: ${rinfo.address}`);
        return;
    }

    try {
        const dev = parse_PunchPkt(dv);
        logger.debug(`Received PunchPkt from ${dev.devId} at ${rinfo.address}`);
        // Emit the raw discovery event with RemoteInfo and DevSerial
        ee.emit("discover", rinfo, dev);
    } catch (parseError) {
         logger.error(`Error parsing PunchPkt from ${rinfo.address}: ${parseError.message}`);
    }
};

/**
 * Starts the UDP device discovery process.
 * @param discovery_ips Array of broadcast/multicast addresses to send discovery packets to.
 * @returns EventEmitter that emits 'discover' (rinfo, dev), 'close', and 'error' events.
 */
export const discoverDevices = (discovery_ips: string[]): EventEmitter => {
    const ee = new EventEmitter();
    const SEND_PORT = 32108; // Port to send discovery packets to
    let sock: import("dgram").Socket | null = null;
    let discoveryRunning = true;
    let discoveryInterval: NodeJS.Timeout | null = null;
    let discoveryTimeout: NodeJS.Timeout | null = null;

    try {
         sock = createSocket("udp4");

         sock.on("error", (err) => {
            logger.error(`UDP discovery socket error:\n${err.stack}`);
            ee.emit("error", err); // Emit error event
            cleanup(); // Attempt cleanup on error
         });

         sock.on("message", (msg, rinfo) => {
             // Rate limiting could be added here if needed
             handleIncomingPunch(msg, ee, rinfo);
         });

         sock.on("listening", () => {
            const listenAddress = sock!.address();
            logger.info(`UDP Discovery socket listening on ${listenAddress.address}:${listenAddress.port}`);
            const ls_buf = create_LanSearch();
            try {
                sock!.setBroadcast(true);
            } catch (err) {
                logger.error(`Failed to set broadcast on discovery socket: ${err.message}`);
                // Continue anyway, might work on some networks/OSes
            }

            const sendLanSearch = () => {
                if (!discoveryRunning || !sock) return;
                const sendBuffer = new Uint8Array(ls_buf.buffer);
                discovery_ips.forEach((discovery_ip) => {
                    logger.debug(`>> Sending LanSearch to [${discovery_ip}:${SEND_PORT}]`);
                    sock!.send(sendBuffer, SEND_PORT, discovery_ip, (err) => {
                        if (err) logger.error(`Error sending LanSearch to ${discovery_ip}: ${err.message}`);
                    });
                });
            };

            logger.info(`Starting UDP discovery search on ${discovery_ips.join(', ')}...`);
            discoveryInterval = setInterval(sendLanSearch, 3000); // Send every 3 seconds
            sendLanSearch(); // Send immediately

            // Set timeout for the discovery duration
            discoveryTimeout = setTimeout(() => {
                logger.info("Discovery process timeout reached (10 seconds). Stopping UDP search.");
                cleanup(); // Cleanup stops sending and closes socket
            }, 10000); // Runs for 10 seconds total
         });

         // Bind to listen for responses
         sock.bind(undefined, "0.0.0.0", () => {
             logger.debug("UDP Discovery socket bound successfully.");
         });

    } catch (initError) {
        logger.error(`Failed to initialize UDP discovery socket: ${initError.message}`);
        ee.emit("error", initError);
        return ee; // Return emitter, but it won't work
    }


    const cleanup = () => {
        if (!discoveryRunning) return; // Prevent multiple cleanups
        discoveryRunning = false;
        logger.debug("Cleaning up discovery resources...");

        if (discoveryInterval) { clearInterval(discoveryInterval); discoveryInterval = null; }
        if (discoveryTimeout) { clearTimeout(discoveryTimeout); discoveryTimeout = null; }

        if (sock) {
            try {
                sock.close();
                // The 'close' event handler below will log the closure
            } catch (closeErr) {
                logger.info(`Error closing UDP discovery socket during cleanup: ${closeErr.message}`);
                sock = null; // Ensure sock is nullified
                ee.emit("close"); // Manually emit close if close throws error
            }
        } else {
             ee.emit("close"); // Emit close if socket wasn't even created/bound
        }
    };

    // Handle socket close event
    sock.on("close", () => {
        logger.info("UDP Discovery socket closed.");
        sock = null; // Nullify the socket variable
        // Ensure timers are cleared if close happens unexpectedly
        if (discoveryInterval) clearInterval(discoveryInterval); discoveryInterval = null;
        if (discoveryTimeout) clearTimeout(discoveryTimeout); discoveryTimeout = null;
        discoveryRunning = false; // Ensure running flag is false
        ee.emit("close"); // Emit the close event for listeners
    });

    // Allow external stop command via the emitter
    ee.on("stop", () => {
        logger.info("Received external stop signal for discovery.");
        cleanup();
    });

    return ee;
};

/**
 * Sends a stop signal to a running discovery emitter.
 * @param ee The EventEmitter returned by discoverDevices.
 */
export const stopDiscovery = (ee: EventEmitter) => {
    ee.emit("stop");
};