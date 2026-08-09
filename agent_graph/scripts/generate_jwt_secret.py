#!/usr/bin/env python3
"""生成适用于 JWT 签名的随机密钥。"""

import secrets


def generate_jwt_secret(length: int = 64) -> str:
    """生成指定字节熵长度的 URL-safe 随机密钥。"""
    return secrets.token_urlsafe(length)


if __name__ == "__main__":
    secret = generate_jwt_secret()
    print("=" * 60)
    print("🔑 JWT密钥生成成功！")
    print("=" * 60)
    print(f"\n{secret}\n")
    print("=" * 60)
    print("📝 使用方法:")
    print("1. 复制上面的密钥")
    print("2. 在项目根目录的 .env 文件中设置:")
    print(f"   JWT_SECRET_KEY={secret}")
    print("3. 启动服务")
    print("=" * 60)
