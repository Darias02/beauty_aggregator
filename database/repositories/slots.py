from typing import Optional, Dict, Any, List

from database.client import supabase


FREE_STATUS = "Свободен"
WAITING_STATUS = "Ожидает подтверждения"
ACTIVE_STATUS = "Занят"


def get_available_slots(
    service_id: int,
    city: Optional[str] = None
) -> List[Dict[str, Any]]:
    query = (
        supabase
        .table("slots")
        .select("*")
        .eq("service_id", service_id)
        .eq("status", FREE_STATUS)
        .order("date_time")
    )

    if city:
        query = query.eq("city", city)

    response = query.execute()
    return response.data or []


def get_slot(slot_id: int) -> Optional[Dict[str, Any]]:
    response = (
        supabase
        .table("slots")
        .select("*")
        .eq("slot_id", slot_id)
        .limit(1)
        .execute()
    )

    if not response.data:
        return None

    return response.data[0]


def get_master_slots(master_id: int) -> List[Dict[str, Any]]:
    response = (
        supabase
        .table("slots")
        .select("*")
        .eq("master_id", master_id)
        .order("date_time")
        .execute()
    )

    return response.data or []


def get_master_active_slots(master_id: int) -> List[Dict[str, Any]]:
    response = (
        supabase
        .table("slots")
        .select("*")
        .eq("master_id", master_id)
        .in_("status", [
            FREE_STATUS,
            WAITING_STATUS,
            ACTIVE_STATUS,
        ])
        .order("date_time")
        .execute()
    )

    return response.data or []


def create_slot(
    master_id: int,
    service_id: int,
    date_time: str,
    city: str = "",
    address: str = "",
    description: str = "",
) -> Optional[Dict[str, Any]]:
    existing = (
        supabase
        .table("slots")
        .select("slot_id")
        .eq("master_id", master_id)
        .eq("date_time", date_time)
        .limit(1)
        .execute()
    )

    if existing.data:
        return None

    response = (
        supabase
        .table("slots")
        .insert({
            "master_id": master_id,
            "service_id": service_id,
            "date_time": date_time,
            "status": FREE_STATUS,
            "city": city,
            "address": address,
            "description": description,
        })
        .select()
        .single()
        .execute()
    )

    return response.data


def update_slot_status(
    slot_id: int,
    status: str
) -> Optional[Dict[str, Any]]:
    response = (
        supabase
        .table("slots")
        .update({"status": status})
        .eq("slot_id", slot_id)
        .select()
        .single()
        .execute()
    )

    return response.data


def cancel_slot(slot_id: int) -> Optional[Dict[str, Any]]:
    return update_slot_status(slot_id, "Отменен")