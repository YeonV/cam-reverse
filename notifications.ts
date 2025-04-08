import { logger } from './logger.js'; // Adjust path as needed

export async function sendCameraDiscoveredNotification(cameraId: string, ipAddress: string, port: number): Promise<void> {
    const token = process.env.SUPERVISOR_TOKEN;

    if (!token) {
        logger.warning("SUPERVISOR_TOKEN not found. Cannot send persistent notification.");
        return; // Cannot proceed without the token
    }

    const apiUrl = 'http://supervisor/core/api/services/persistent_notification/create';
    const notificationId = `camera_handler_discovered_${cameraId}`; // Unique ID per camera
    const title = "New Camera Found";
    // Instructions for manual setup using the reliable host network URL
    const message = `Discovered camera '${cameraId}' at IP address ${ipAddress}.\n\nTo add it manually:\n1. Copy this URL to your clipboard:\n\n   \`http://localhost:${port}/camera/${cameraId}\`\n\n2. add it <a href="/_my_redirect/config_flow_start?domain=mjpeg">here</a>`;

    const body = JSON.stringify({
        notification_id: notificationId,
        title: title,
        message: message,
    });

    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
    };

    logger.debug(`Sending notification for ${cameraId} to ${apiUrl}`);

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: headers,
            body: body,
        });

        if (!response.ok) {
            // Log error details if possible
            let errorBody = '';
            try {
                errorBody = await response.text();
            } catch (e) { /* ignore */ }
            throw new Error(`API request failed with status ${response.status}: ${response.statusText}. Body: ${errorBody}`);
        }

        logger.info(`Successfully sent persistent notification for camera ${cameraId}. Status: ${response.status}`);

    } catch (error) {
        logger.error(`Error sending persistent notification for ${cameraId}: ${error.message}`);
        // Re-throw or handle as needed
        throw error;
    }
}
