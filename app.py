from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room
from datetime import datetime
import random
import uuid

APP_NAME = "Nimbus Chat"

MAX_IMAGE_CHARS = 2_500_000    # biggest photo allowed in a message
MAX_AVATAR_CHARS = 250_000     # biggest profile photo
MAX_HISTORY = 100              # messages kept per room (in memory)
ALLOWED_IMAGES = ("data:image/jpeg;base64,", "data:image/png;base64,",
                  "data:image/webp;base64,", "data:image/gif;base64,")

app = Flask(__name__)
app.config['SECRET_KEY'] = 'nimbus-chat-secret-key'
socketio = SocketIO(app, cors_allowed_origins="*",
                    max_http_buffer_size=6 * 1024 * 1024)

users = {}          # sid -> {username, color, avatar, current_room}
online_users = {}   # username -> {color, avatar, sid}
rooms = {
    "general": {"name": "General", "type": "group", "members": set()}
}
messages = {"general": []}

AVATAR_COLORS = [
    "#e17076", "#7bc862", "#e5ca77", "#65aadd",
    "#a695e7", "#ee7aae", "#6ec9cb", "#faa774"
]


# ---------- helpers ----------
def clean_image(data_url, limit):
    """Return the image only if it looks like a safe, small image."""
    if (isinstance(data_url, str)
            and data_url.startswith(ALLOWED_IMAGES)
            and len(data_url) <= limit):
        return data_url
    return ""


def online_payload():
    return {u: {"color": d["color"], "avatar": d["avatar"]}
            for u, d in online_users.items()}


def get_private_room_id(user1, user2):
    return "private_" + "_".join(sorted([user1.lower(), user2.lower()]))


def room_name_for(room, username):
    """Private chats show the OTHER person's name."""
    if room["type"] == "private":
        others = [m for m in room["members"] if m != username]
        return others[0] if others else username
    return room["name"]


def get_visible_rooms(username):
    result = []
    for rid, room in rooms.items():
        if room["type"] == "group" or username in room["members"]:
            result.append({"id": rid,
                           "name": room_name_for(room, username),
                           "type": room["type"]})
    return result


def now():
    return datetime.now().strftime("%H:%M")


def switch_user(user, room_id):
    leave_room(user["current_room"])
    join_room(room_id)
    user["current_room"] = room_id
    emit('room_switched', {
        "room_id": room_id,
        "room_name": room_name_for(rooms[room_id], user["username"]),
        "messages": messages.get(room_id, [])
    })


# ---------- routes ----------
@app.route('/')
def index():
    return render_template('index.html', app_name=APP_NAME)


# ---------- socket events ----------
@socketio.on('connect')
def on_connect():
    print("Client connected")


@socketio.on('join')
def on_join(data):
    username = str(data.get('username', '')).strip()[:20]
    if len(username) < 2:
        return

    if any(u.lower() == username.lower() for u in online_users):
        emit('join_error', {"message": "That name is already online. Pick another one."})
        return

    color = random.choice(AVATAR_COLORS)
    avatar = clean_image(data.get('avatar'), MAX_AVATAR_CHARS)

    users[request.sid] = {"username": username, "color": color,
                          "avatar": avatar, "current_room": "general"}
    online_users[username] = {"color": color, "avatar": avatar, "sid": request.sid}

    join_room("general")
    rooms["general"]["members"].add(username)

    emit('init_data', {
        "username": username,
        "color": color,
        "avatar": avatar,
        "rooms": get_visible_rooms(username),
        "online_users": online_payload(),
        "messages": messages["general"]
    })

    emit('user_joined', {
        "username": username,
        "online_users": online_payload(),
        "message": f"{username} joined the chat",
        "time": now()
    }, broadcast=True, include_self=False)


@socketio.on('send_message')
def on_message(data):
    user = users.get(request.sid)
    if not user:
        return

    text = str(data.get("message", "")).strip()[:1000]
    image = clean_image(data.get("image"), MAX_IMAGE_CHARS)
    if not text and not image:
        return

    room = user["current_room"]
    msg = {
        "id": str(uuid.uuid4())[:8],
        "username": user["username"],
        "color": user["color"],
        "message": text,
        "image": image,
        "time": now(),
        "room": room
    }

    messages.setdefault(room, []).append(msg)
    messages[room] = messages[room][-MAX_HISTORY:]

    emit('receive_message', msg, room=room)


@socketio.on('switch_room')
def on_switch_room(data):
    user = users.get(request.sid)
    room_id = data.get("room_id")
    if not user or room_id not in rooms:
        return
    room = rooms[room_id]
    if room["type"] == "private" and user["username"] not in room["members"]:
        return
    switch_user(user, room_id)


@socketio.on('create_room')
def on_create_room(data):
    user = users.get(request.sid)
    if not user:
        return

    name = str(data.get("name", "")).strip()[:30]
    if not name:
        return

    room_id = "group_" + str(uuid.uuid4())[:8]
    rooms[room_id] = {"name": name, "type": "group", "members": {user["username"]}}
    messages[room_id] = []

    emit('room_created', {"id": room_id, "name": name, "type": "group"}, broadcast=True)
    switch_user(user, room_id)


@socketio.on('start_private')
def on_start_private(data):
    user = users.get(request.sid)
    if not user:
        return

    target = data.get("username")
    if not target or target not in online_users:
        return

    room_id = get_private_room_id(user["username"], target)
    if room_id not in rooms:
        rooms[room_id] = {"name": "", "type": "private",
                          "members": {user["username"], target}}
        messages[room_id] = []

    # Put the other person in the room too, so they receive messages
    target_sid = online_users[target]["sid"]
    join_room(room_id, sid=target_sid)

    emit('room_created', {"id": room_id, "name": target, "type": "private"})
    emit('room_created', {"id": room_id, "name": user["username"], "type": "private"},
         to=target_sid)

    switch_user(user, room_id)


@socketio.on('disconnect')
def on_disconnect():
    user = users.pop(request.sid, None)
    if not user:
        return

    username = user["username"]
    online_users.pop(username, None)

    emit('user_left', {
        "username": username,
        "online_users": online_payload(),
        "message": f"{username} left",
        "time": now()
    }, broadcast=True)


if __name__ == '__main__':
    print(f"\n✅ {APP_NAME} is running!")
    print("→ Open: http://127.0.0.1:5000\n")
    socketio.run(app, debug=True, host='0.0.0.0', port=5000,
                 allow_unsafe_werkzeug=True)
