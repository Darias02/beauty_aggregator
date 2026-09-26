from typing import Optional, Dict, Any, List

from database.client import supabase


def get_all_services() -> List[Dict[str, Any]]:
    response = (
        supabase
        .table("services")
        .select("*")
        .order("service_id")
        .execute()
    )

    return response.data or []


def get_service_by_id(service_id: int) -> Optional[Dict[str, Any]]:
    response = (
        supabase
        .table("services")
        .select("*")
        .eq("service_id", service_id)
        .limit(1)
        .execute()
    )

    if not response.data:
        return None

    return response.data[0]


def get_service_by_name(name: str) -> Optional[Dict[str, Any]]:
    response = (
        supabase
        .table("services")
        .select("*")
        .eq("name", name)
        .limit(1)
        .execute()
    )

    if not response.data:
        return None

    return response.data[0]