"""JWT access token 与 refresh token 的签发和验证。"""
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, Tuple
from jose import JWTError, jwt
from fastapi import HTTPException, status
import secrets

from agent_graph.app.core.config import get_settings


settings = get_settings()


def create_tokens(user_id: str, role: str) -> Tuple[str, str, str, datetime]:
    """创建一组 access token 与 refresh token。"""
    now = datetime.now()

    access_expire = now + timedelta(minutes=settings.jwt_access_token_expire_minutes)
    access_payload = {
        "sub": user_id,
        "role": role,
        "type": "access",
        "iat": int(now.timestamp()),
        "exp": int(access_expire.timestamp())
    }
    access_token = jwt.encode(
        access_payload,
        settings.jwt_secret_key.get_secret_value(),
        algorithm=settings.jwt_algorithm
    )

    refresh_expire = now + timedelta(days=settings.jwt_refresh_token_expire_days)
    refresh_token_id = secrets.token_urlsafe(32)

    refresh_payload = {
        "sub": user_id,
        "type": "refresh",
        "jti": refresh_token_id,
        "iat": int(now.timestamp()),
        "exp": int(refresh_expire.timestamp())
    }
    refresh_token = jwt.encode(
        refresh_payload,
        settings.jwt_secret_key.get_secret_value(),
        algorithm=settings.jwt_algorithm
    )

    return access_token, refresh_token, refresh_token_id, refresh_expire


def create_access_token(user_id: str, role: str, expires_delta: Optional[timedelta] = None) -> str:
    """创建 access token，并允许覆盖默认有效期。"""
    now = datetime.now()

    if expires_delta:
        expire = now + expires_delta
    else:
        expire = now + timedelta(minutes=settings.jwt_access_token_expire_minutes)

    payload: Dict[str, Any] = {
        "sub": user_id,
        "role": role,
        "type": "access",
        "iat": int(now.timestamp()),
        "exp": int(expire.timestamp())
    }

    encoded_jwt = jwt.encode(
        payload,
        settings.jwt_secret_key.get_secret_value(),
        algorithm=settings.jwt_algorithm
    )

    return encoded_jwt


def verify_token(token: str) -> Dict[str, Any]:
    """验证 access token 并返回 payload。"""
    return verify_access_token(token)


def verify_access_token(token: str) -> Dict[str, Any]:
    """验证 access token 的签名、有效期、类型和必要字段。"""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="无效的访问令牌",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key.get_secret_value(),
            algorithms=[settings.jwt_algorithm]
        )

        token_type = payload.get("type")
        if token_type and token_type != "access":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token类型错误，需要Access Token",
                headers={"WWW-Authenticate": "Bearer"},
            )

        user_id: Optional[str] = payload.get("sub")
        role: Optional[str] = payload.get("role")

        if user_id is None or role is None:
            raise credentials_exception

        return payload

    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Access Token验证失败: {str(e)}",
            headers={"WWW-Authenticate": "Bearer"},
        )


def verify_refresh_token(token: str) -> Dict[str, Any]:
    """验证 refresh token 的签名、有效期、类型和必要字段。"""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="无效的刷新令牌",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key.get_secret_value(),
            algorithms=[settings.jwt_algorithm]
        )

        token_type = payload.get("type")
        if token_type != "refresh":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token类型错误，需要Refresh Token",
                headers={"WWW-Authenticate": "Bearer"},
            )

        user_id: Optional[str] = payload.get("sub")
        token_id: Optional[str] = payload.get("jti")

        if user_id is None or token_id is None:
            raise credentials_exception

        return payload

    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Refresh Token验证失败: {str(e)}",
            headers={"WWW-Authenticate": "Bearer"},
        )


def decode_token_without_verification(token: str) -> Optional[Dict[str, Any]]:
    """不验证签名和有效期地解码 JWT，仅供受控诊断流程使用。"""
    try:
        payload = jwt.decode(
            token,
            options={"verify_signature": False, "verify_exp": False}
        )
        return payload
    except JWTError:
        return None
