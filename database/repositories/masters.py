from typing import Optional, Dict, Any

from database.client import supabase


def get_master(master_id: int) -> Optional[Dict[str, Any]]:
    response = (
        supabase
        .table("masters")
        .select("*")
        .eq("master_id", master_id)
        .limit(1)
        .execute()
    )

    if not response.data:
        return None

    return response.data[0]


def check_is_master(master_id: int) -> bool:
    return get_master(master_id) is not None