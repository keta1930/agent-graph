"""初始化应用运行所需的系统数据。"""

import logging
from datetime import datetime

from pymongo.errors import DuplicateKeyError

from agent_graph.app.auth.password import hash_password
from agent_graph.app.core.config import get_settings
from agent_graph.app.infrastructure.database.mongodb import mongodb_client

logger = logging.getLogger(__name__)
settings = get_settings()


async def initialize_super_admin() -> None:
    """按配置创建初始超级管理员。"""
    admin_username = settings.admin_username
    existing = await mongodb_client.users_collection.find_one(
        {"user_id": admin_username}
    )

    if existing:
        logger.info("Super admin '%s' already exists", admin_username)
        return

    now = datetime.now()
    await mongodb_client.users_collection.insert_one(
        {
            "user_id": admin_username,
            "password_hash": hash_password(
                settings.admin_password.get_secret_value()
            ),
            "role": "super_admin",
            "is_active": True,
            "created_at": now,
            "updated_at": now,
            "last_login_at": None,
        }
    )
    logger.info("Super admin '%s' created", admin_username)


async def initialize_team_settings() -> None:
    """创建默认团队设置。"""
    existing = await mongodb_client.team_settings_collection.find_one(
        {"_id": "team_config"}
    )

    if existing:
        logger.info("Team settings already exist")
        return

    now = datetime.now()
    try:
        await mongodb_client.team_settings_collection.insert_one(
            {
                "_id": "team_config",
                "team_name": "My Team",
                "created_at": now,
                "updated_at": now,
                "updated_by": "system",
            }
        )
    except DuplicateKeyError:
        logger.info("Team settings were created concurrently")
        return

    logger.info("Default team settings created")


async def initialize_system() -> None:
    """初始化管理员账户和默认团队设置。"""
    logger.info("Starting system initialization")
    await initialize_super_admin()
    await initialize_team_settings()
    logger.info("System initialization completed")
