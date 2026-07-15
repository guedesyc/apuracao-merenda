import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEMO_DATA = ROOT / "public" / "demo-data.json"
OUTPUT = ROOT / "supabase" / "seed.sql"


def sql(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace("'", "''")
    return f"'{text}'"


def json_sql(value):
    return sql(json.dumps(value, ensure_ascii=False)) + "::jsonb"


def password_hash(password):
    return hashlib.sha256(str(password).encode("utf-8")).hexdigest()


def route_id(name):
    text = name.lower()
    replacements = str.maketrans("áàãâéêíóôõúüç", "aaaaeeiooouuc")
    text = text.translate(replacements)
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return f"route-{text or 'sem-rota'}"


def main():
    db = json.loads(DEMO_DATA.read_text(encoding="utf-8"))
    lines = [
        "-- Seed inicial gerado a partir de demo-data.json.",
        "-- Execute depois de supabase/schema.sql.",
        "begin;",
        "truncate table public.entry_items, public.entries, public.monthly_closures, public.exports, public.audit_logs, public.nutritionist_schools, public.schools, public.routes, public.cards, public.profiles, public.settings restart identity cascade;",
    ]

    for user in db["users"]:
        lines.append(
            "insert into public.profiles (id, name, username, password_hash, role, active) values "
            f"({sql(user['id'])}, {sql(user['name'])}, {sql(user['username'])}, {sql(password_hash(user.get('password') or '123'))}, {sql(user['role'])}, {sql(user.get('active', True))});"
        )

    route_names = sorted({school.get("route") or "SEM ROTA" for school in db["schools"]})
    route_ids = {name: route_id(name) for name in route_names}
    for name, rid in route_ids.items():
        lines.append(f"insert into public.routes (id, name) values ({sql(rid)}, {sql(name)}) on conflict (id) do nothing;")

    for school in db["schools"]:
        code = school["name"].split(" - ", 1)[0] if " - " in school["name"] else None
        rid = route_ids.get(school.get("route") or "SEM ROTA")
        lines.append(
            "insert into public.schools (id, row_number, code, name, short_name, route_id, company, address, active) values "
            f"({sql(school['id'])}, {sql(school['row'])}, {sql(code)}, {sql(school['name'])}, {sql(school.get('shortName') or school['name'])}, {sql(rid)}, {sql(school.get('company'))}, {sql(school.get('address'))}, {sql(school.get('active', True))});"
        )
        for nutritionist_id in school.get("nutritionistIds", []):
            lines.append(
                "insert into public.nutritionist_schools (profile_id, school_id) values "
                f"({sql(nutritionist_id)}, {sql(school['id'])}) on conflict do nothing;"
            )

    for card in db["cards"]:
        lines.append(
            "insert into public.cards (id, number, label, description, price, column_number, active) values "
            f"({sql(card['id'])}, {sql(card['number'])}, {sql(card['label'])}, {sql(card.get('description'))}, {sql(card.get('price', 0))}, {sql(card['column'])}, true);"
        )

    lines.append(f"insert into public.settings (key, value) values ('app', {json_sql(db.get('settings', {}))});")
    lines.append("commit;")

    OUTPUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Seed gerado em {OUTPUT}")


if __name__ == "__main__":
    main()
