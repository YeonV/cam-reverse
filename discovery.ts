import { createSocket, RemoteInfo } from "node:dgram";
import EventEmitter from "node:events";

import { Commands } from "./datatypes.js";
import { create_LanSearch, parse_PunchPkt } from "./impl.js";
import { logger } from "./logger.js";
import { config } from "./settings.js";
import { DevSerial } from "./impl.js";

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
    logger.debug("Received a PunchPkt message");
    ee.emit("discover", rinfo, parse_PunchPkt(dv));
};

export const discoverDevices = (discovery_ips: string[]): EventEmitter => {
    const sock = createSocket("udp4");
    const SEND_PORT = 32108;
    const ee = new EventEmitter();
    let devicesDiscovered: Record<string, boolean> = {}; // Track discovered devices
    let discoveryRunning = true; // Flag to control discovery
    let discoveryInterval: NodeJS.Timeout | null = null; // Store the interval ID
    let discoveryTimeout: NodeJS.Timeout | null = null; // Timeout to stop discovery after 10 seconds

    sock.on("error", (err) => {
        console.error(`sock error:\n${err.stack}`);
        sock.close();
    });

    sock.on("message", (msg, rinfo) => handleIncomingPunch(msg, ee, rinfo));

    sock.on("listening", () => {
        let ls_buf = create_LanSearch();
        sock.setBroadcast(true);

        const sendLanSearch = () => {
            if (!discoveryRunning) {
                return; // Stop if discovery is no longer running
            }
            discovery_ips.forEach((discovery_ip) => {
                logger.log("trace", `>> LanSearch [${discovery_ip}]`);
                sock.send(new Uint8Array(ls_buf.buffer), SEND_PORT, discovery_ip);
            });
        };

        discovery_ips.forEach((discovery_ip) => {
            logger.info(`Searching for devices on ${discovery_ip}`);
        });

        discoveryInterval = setInterval(sendLanSearch, 3000);
        sendLanSearch(); // Send the first LanSearch immediately

        // Stop discovery after 10 seconds
        discoveryTimeout = setTimeout(() => {
            discoveryRunning = false;
            if (discoveryInterval) {
                clearInterval(discoveryInterval);
            }
            sock.close();
            logger.info("Discovery process stopped after 10 seconds.");
        }, 10000);
    });

    sock.bind();

    sock.on("close", () => {
        if (discoveryInterval) {
            clearInterval(discoveryInterval);
        }
        if (discoveryTimeout) {
            clearTimeout(discoveryTimeout);
        }
    });

    ee.on("close", () => {
        discoveryRunning = false;
        if (discoveryInterval) {
            clearInterval(discoveryInterval);
        }
        if (discoveryTimeout) {
            clearTimeout(discoveryTimeout);
        }
        sock.close();
    });

    ee.on("discover", (rinfo: RemoteInfo, dev: DevSerial) => {
        if (devicesDiscovered[dev.devId]) {
            logger.info(`Camera ${dev.devId} at ${rinfo.address} already discovered, ignoring`);
        } else {
            devicesDiscovered[dev.devId] = true;
            logger.info(`Discovered new camera: ${dev.devId} at ${rinfo.address}`);
        }
    });

    return ee;
};