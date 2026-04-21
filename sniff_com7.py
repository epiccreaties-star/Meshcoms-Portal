"""
MeshCore handshake + message sniffer.
Sends getSelfInfo (command 1) to wake the node, then listens for all frames.
"""
import serial, time, struct

PORT = 'COM7'
BAUD = 115200

EVENT_NAMES = {
    7:   'DM (Direct Message)',
    8:   'Channel Message',
    128: 'Advert/Announce (0x80)',
    129: 'Node Update (0x81)',
    130: 'Send ACK (0x82)',
    131: 'Pending Msgs (0x83)',
    136: 'Login/Auth (0x88)',
    138: 'New Contact (0x8A)',
}

def encode_frame(payload: bytes) -> bytes:
    """Encode using meshcore.js serial framing: <LEN_LE2><PAYLOAD>"""
    length = len(payload)
    return bytes([0x3c]) + struct.pack('<H', length) + payload + bytes([0x3e])

def get_self_info_cmd() -> bytes:
    """Command 1 = getSelfInfo"""
    return encode_frame(bytes([1]))

s = serial.Serial(PORT, BAUD, timeout=0.1)
print(f"[OK] Connected to {PORT}. Sending getSelfInfo ping...")

# Send getSelfInfo to trigger response
time.sleep(0.5)
s.write(get_self_info_cmd())
print("[SENT] getSelfInfo command")

buf = bytearray()
raw_accum = bytearray()
start = time.time()
timeout = 15

print(f"Listening for {timeout}s...")

while time.time() - start < timeout:
    raw = s.read(256)
    if not raw:
        continue
    raw_accum.extend(raw)
    print(f"[RAW] {raw.hex()}")

s.close()
print("\n[DONE]")
print(f"Total raw bytes: {raw_accum.hex()}")
