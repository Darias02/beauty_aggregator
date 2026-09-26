from database.client import supabase


def add_user(
    user_id: int,
    name: str,
    phone_number: str | None = None,
):
    data = {
        "user_id": user_id,
        "name": name,
    }

    if phone_number:
        data["phone_number"] = phone_number

    response = (
        supabase
        .table("users")
        .upsert(data)
        .execute()
    )

    return response.data