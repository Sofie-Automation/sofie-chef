# WebHID Device Configuration

This document explains how to configure Sofie Chef to automatically approve specific WebHID devices, eliminating the need to manually approve them each time the browser is restarted.

## Configuration

Add the `allowedWebHIDDevices` array to your window configuration in the Chef config file. Each device entry should specify the vendor ID and product ID, and optionally usage page and usage values.

### Example Configuration

```json
{
	"windows": {
		"default": {
			"width": 1280,
			"height": 720,
			"defaultURL": "https://example.com",
			"allowedWebHIDDevices": [
				{
					"vendorId": 1133,
					"productId": 49824,
					"usagePage": 1,
					"usage": 6
				},
				{
					"vendorId": 1452,
					"productId": 613
				}
			]
		}
	}
}
```

### Device Properties

- **vendorId** (required): The vendor ID of the HID device (decimal number)
- **productId** (required): The product ID of the HID device (decimal number)
- **usagePage** (optional): The HID usage page filter
- **usage** (optional): The HID usage filter

### Finding Device IDs

You can find device IDs using several methods:

#### Method 1: Browser DevTools Console

When a WebHID device is connected, you can inspect it in the browser console:

```javascript
// List all connected HID devices
navigator.hid.getDevices().then((devices) => {
	devices.forEach((device) => {
		console.log(`Vendor ID: ${device.vendorId} (0x${device.vendorId.toString(16)})`)
		console.log(`Product ID: ${device.productId} (0x${device.productId.toString(16)})`)
		console.log(`Usage Page: ${device.usagePage}`)
		console.log(`Usage: ${device.usage}`)
	})
})
```

#### Method 2: System Tools

**Windows:**

- Device Manager → View → Devices by type → Human Interface Devices
- Right-click device → Properties → Details → Hardware Ids

**macOS:**

- System Information → Hardware → USB
- Look for vendor ID and product ID in the device details

**Linux:**

- `lsusb` command shows connected USB devices with vendor:product IDs

### Important Notes

1. **Decimal vs Hexadecimal**: The configuration uses decimal numbers, but device IDs are often displayed in hexadecimal. Convert hex values to decimal for the config.

2. **Security**: Only add devices you trust, as approved devices will have full access to the web page without user confirmation.

3. **Scope**: Device approval is per-window. Each window can have its own allowed device list.

4. **Logging**: Chef will log when devices are auto-approved or denied, making it easier to debug configuration issues.

### Troubleshooting

If your device isn't being auto-approved:

1. Check the Chef logs for WebHID permission messages
2. Verify the vendor ID and product ID are correct and in decimal format
3. Ensure the device is properly connected before loading the page
4. Try omitting the optional `usagePage` and `usage` filters if specified
