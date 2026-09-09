import time

from jose import jwt


def expired_access(user_id, secret):
    """只为本轮隔离身份生成可被真实后端识别的过期凭据。"""
    now = int(time.time())
    return jwt.encode({"sub": user_id, "role": "super_admin", "type": "access", "iat": now - 120, "exp": now - 60}, secret, algorithm="HS256")
