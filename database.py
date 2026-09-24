import os
from datetime import datetime
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

supabase: Client = create_client(
    os.environ.get("SUPABASE_URL"),
    os.environ.get("SUPABASE_KEY")
)

def add_user(user_id: int, name: str, phone_number: str = None):
    data = {"user_id": user_id, "name": name}
    if phone_number:
        data["phone_number"] = phone_number
    response = supabase.table("users").upsert(data).execute()
    return response.data

def get_all_services():
    return supabase.table("services").select("*").execute().data

def get_available_services(user_id: int):
    return supabase.table("services").select("*").execute().data

def get_available_slots(service_id: int, user_id: int):
    return supabase.table("slots").select("*").eq("service_id", service_id).eq("status", "Свободен").execute().data

def create_booking(user_id: int, slot_id: int):
    slot_res = supabase.table("slots").select("service_id, master_id, status, date_time").eq("slot_id", slot_id).execute().data
    if not slot_res or slot_res[0]['status'] != 'Свободен':
        return None
    
    slot = slot_res[0]
    
    booking_res = supabase.table("bookings").insert({
        "user_id": user_id, 
        "slot_id": slot_id, 
        "status": "Ожидает подтверждения мастера"
    }).execute().data[0]
    
    supabase.table("slots").update({"status": "Ожидает подтверждения"}).eq("slot_id", slot_id).execute()
    
    service_res = supabase.table("services").select("name").eq("service_id", slot['service_id']).execute().data[0]
    
    return {
        "booking_id": booking_res['booking_id'],
        "master_id": slot['master_id'],
        "service_name": service_res['name'],
        "date_time": datetime.fromisoformat(slot['date_time'].replace('Z', '+00:00'))
    }

def confirm_booking_db(booking_id: int):
    booking = supabase.table("bookings").update({"status": "Активна"}).eq("booking_id", booking_id).execute().data[0]
    supabase.table("slots").update({"status": "Занят"}).eq("slot_id", booking['slot_id']).execute()
    return booking['user_id']

def reject_booking_db(booking_id: int, reason: str):
    booking = supabase.table("bookings").update({"status": "Отменена мастером"}).eq("booking_id", booking_id).execute().data[0]
    new_slot_status = "Отменен" if reason == "plans" else "Свободен"
    supabase.table("slots").update({"status": new_slot_status}).eq("slot_id", booking['slot_id']).execute()
    return booking['user_id']

def check_is_master(master_id: int):
    result = supabase.table("masters").select("master_id").eq("master_id", master_id).execute().data
    return len(result) > 0

def add_new_slot(master_id: int, service_id: int, dt_str: str):
    existing = supabase.table("slots").select("slot_id").eq("master_id", master_id).eq("date_time", dt_str).execute().data
    if existing:
        return False
    supabase.table("slots").insert({
        "date_time": dt_str,
        "status": "Свободен",
        "master_id": master_id,
        "service_id": service_id
    }).execute()
    return True