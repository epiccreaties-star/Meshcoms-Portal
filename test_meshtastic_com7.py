import meshtastic
import meshtastic.serial_interface
import time

PORT = 'COM7'
print(f"Connecting to Meshtastic on {PORT}...")

try:
    interface = meshtastic.serial_interface.SerialInterface(PORT)
    print("Connected! Sending test message...")
    
    interface.sendText("Test message from Antigravity (AI) via Python!")
    print("Message sent! Closing interface...")
    
    time.sleep(2) # Give it a moment to TX
    interface.close()
    print("Done.")
except Exception as e:
    print(f"Error: {e}")
