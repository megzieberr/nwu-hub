"""Generate a VAPID key pair for web-push notifications (NWU Study Hub).

VAPID keys are how the phone's push service knows the notifications really come from your app.
You get TWO keys:
  - a PUBLIC key  -> goes in the website (src/lib/push-config.js)
  - a PRIVATE key -> stays SECRET, only inside Supabase (VAPID_PRIVATE_KEY)

Run with:  python tools/gen_vapid.py
Requires:  python -m pip install cryptography
"""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def main():
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    public_bytes = public_key.public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    private_bytes = private_key.private_numbers().private_value.to_bytes(32, "big")

    print("=" * 60)
    print("VAPID keys generated. Keep the PRIVATE key secret!")
    print("=" * 60)
    print()
    print("PUBLIC  (paste into src/lib/push-config.js):")
    print(b64url(public_bytes))
    print()
    print("PRIVATE (Supabase secret only / VAPID_PRIVATE_KEY):")
    print(b64url(private_bytes))
    print()


if __name__ == "__main__":
    main()
