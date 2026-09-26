from typing import Optional, Dict, Any, List

from database.client import supabase
from database.repositories.slots import (
    FREE_STATUS,
    WAITING_STATUS,
    ACTIVE_STATUS,
)


PENDING_BOOKING = "Ожидает подтверждения мастера"
ACTIVE_BOOKING = "Активна"
REJECTED_BY_MASTER = "Отменена мастером"


def get_booking(booking_id: int) -> Optional[Dict[str, Any]]:
    response = (
        supabase
        .table("bookings")
        .select("*")
        .eq("booking_id", booking_id)
        .limit(1)
        .execute()
    )

    if not response.data:
        return None

    return response.data[0]


def get_user_bookings(user_id: int) -> List[Dict[str, Any]]:
    response = (
        supabase
        .table("bookings")
        .select("*")
        .eq("user_id", user_id)
        .order("booking_id", desc=True)
        .execute()
    )

    return response.data or []


def get_bookings_for_slots(
    slot_ids: List[int]
) -> List[Dict[str, Any]]:
    if not slot_ids:
        return []

    response = (
        supabase
        .table("bookings")
        .select("*")
        .in_("slot_id", slot_ids)
        .order("booking_id", desc=True)
        .execute()
    )

    return response.data or []


def create_booking(
    user_id: int,
    slot_id: int
) -> Optional[Dict[str, Any]]:
    slot_response = (
        supabase
        .table("slots")
        .select(
            "slot_id, master_id, service_id, status, "
            "date_time, city, address, description"
        )
        .eq("slot_id", slot_id)
        .limit(1)
        .execute()
    )

    if not slot_response.data:
        return None

    slot = slot_response.data[0]

    if slot["status"] != FREE_STATUS:
        return None

    booking_response = (
        supabase
        .table("bookings")
        .insert({
            "user_id": user_id,
            "slot_id": slot_id,
            "status": PENDING_BOOKING,
        })
        .select()
        .single()
        .execute()
    )

    booking = booking_response.data

    if not booking:
        return None

    supabase.table("slots").update({
        "status": WAITING_STATUS
    }).eq(
        "slot_id",
        slot_id
    ).execute()

    service_response = (
        supabase
        .table("services")
        .select("name")
        .eq("service_id", slot["service_id"])
        .limit(1)
        .execute()
    )

    service_name = ""
    if service_response.data:
        service_name = service_response.data[0].get("name", "")

    return {
        "booking_id": booking["booking_id"],
        "user_id": booking["user_id"],
        "slot_id": booking["slot_id"],
        "master_id": slot["master_id"],
        "service_id": slot["service_id"],
        "service_name": service_name,
        "date_time": slot["date_time"],
        "city": slot.get("city", ""),
        "address": slot.get("address", ""),
        "description": slot.get("description", ""),
        "status": booking["status"],
    }


def confirm_booking_db(
    booking_id: int
) -> Optional[int]:
    booking = get_booking(booking_id)

    if not booking:
        return None

    updated_booking = (
        supabase
        .table("bookings")
        .update({
            "status": ACTIVE_BOOKING
        })
        .eq("booking_id", booking_id)
        .select()
        .single()
        .execute()
    )

    if not updated_booking.data:
        return None

    supabase.table("slots").update({
        "status": ACTIVE_STATUS
    }).eq(
        "slot_id",
        booking["slot_id"]
    ).execute()

    return booking["user_id"]


def reject_booking_db(
    booking_id: int,
    reason: str
) -> Optional[int]:
    booking = get_booking(booking_id)

    if not booking:
        return None

    updated_booking = (
        supabase
        .table("bookings")
        .update({
            "status": REJECTED_BY_MASTER
        })
        .eq("booking_id", booking_id)
        .select()
        .single()
        .execute()
    )

    if not updated_booking.data:
        return None

    new_slot_status = (
        "Отменен"
        if reason == "plans"
        else FREE_STATUS
    )

    supabase.table("slots").update({
        "status": new_slot_status
    }).eq(
        "slot_id",
        booking["slot_id"]
    ).execute()

    return booking["user_id"]