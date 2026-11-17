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
        # Registration must not overwrite a name edited through BB-07.
        .upsert(data, on_conflict="user_id", ignore_duplicates=True)
        .execute()
    )

    return response.data