import mqtt, { MqttClient } from 'mqtt';
import { logger } from './logger'; // Assuming logger is configured

let client: MqttClient | null = null;

export function initializeMqtt(): MqttClient | null {
    if (client && client.connected) {
        return client;
    }
    // ... get host, port, user, pass from process.env ...
    const mqttHost = process.env.MQTT_HOST;
    const mqttPort = process.env.MQTT_PORT;
    const mqttUsername = process.env.MQTT_USERNAME;
    const mqttPassword = process.env.MQTT_PASSWORD;
    const mqttProtocol = process.env.MQTT_PROTOCOL || 'mqtt';

    if (!mqttHost || !mqttPort) {
         logger.info("MQTT config missing, client not initialized.");
         console.log("DEBUG: MQTT config missing, client not initialized.");
         return null;
    }
    // ... construct brokerUrl and options ...
    const brokerUrl = `${mqttProtocol}://${mqttHost}:${mqttPort}`;
    const options = {
        clientId: `cam_reverse_addon_${Math.random().toString(16).substring(2, 8)}`,
        username: mqttUsername,
        password: mqttPassword,
        clean: true, // Start with a clean session
        connectTimeout: 10000, // 10 seconds timeout
    };
    console.log("DEBUG: Initializing central MQTT client...");
    client = mqtt.connect(brokerUrl, options);

    client.on('connect', () => {
        logger.info("Central MQTT Client Connected");
    });
    client.on('error', (err) => {
         logger.error("Central MQTT Client Error:", err);
         // Maybe set client=null here? Or implement reconnect?
    });
     client.on('close', () => {
         logger.info("Central MQTT Client Closed");
         client = null; // Allow re-initialization on next call? Or handle reconnect.
     });
     // ... other handlers ...
     client.on('offline', () => {
        logger.info('MQTT client is offline.');
        client = null;
    });

    return client;
}

export function getMqttClient(): MqttClient | null {
    return client;
}

export function closeMqtt() {
    if(client) {
        console.log("DEBUG: Closing central MQTT client.");
        client.end();
        client = null;
    }
}
