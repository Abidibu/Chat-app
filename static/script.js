const socket = io();
const $ = id => document.getElementById(id);

const loginScreen = $('login-screen');
const chatContainer = $('chat-container');
const usernameInput = $('username-input');
const joinBtn = $('join-btn');
const avatarPick = $('avatar-pick');
const avatarInput = $('avatar-input');
const messageInput = $('message-input');
const sendBtn = $('send-btn');
const attachBtn = $('attach-btn');
const imageInput = $('image-input');
const messagesDiv = $('messages');
const onlineList = $('online-list');
const roomsList = $('rooms-list');
const chatTitle = $('chat-title');
const statusEl = $('status');
const emojiBtn = $('emoji-btn');
const emojiPicker = $('emoji-picker');
const newRoomBtn = $('new-room-btn');
const newRoomModal = $('new-room-modal');
const newRoomName = $('new-room-name');
const createRoomBtn = $('create-room-btn');
const cancelRoomBtn = $('cancel-room-btn');
const backBtn = $('back-btn');
const sidebar = $('sidebar');
const myAvatarEl = $('my-avatar');
const lightbox = $('lightbox');
const lightboxImg = $('lightbox-img');

let currentUsername = '';
let currentRoom = 'general';
let pendingAvatar = '';
const people = {};   // username -> {color, avatar}  (remembers everyone we've seen)
const unread = {};   // roomId -> count

// ===== Image helper: shrink a photo so it sends fast =====
function shrinkImage(file, maxSize, quality, square) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (square) {
                const side = Math.min(img.width, img.height);
                canvas.width = canvas.height = Math.min(maxSize, side);
                const sx = (img.width - side) / 2;
                const sy = (img.height - side) / 2;
                ctx.drawImage(img, sx, sy, side, side, 0, 0, canvas.width, canvas.height);
            } else {
                const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            }
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
        img.src = url;
    });
}

// Round avatar: photo if we have one, otherwise first letter
function makeAvatar(username, color, avatar, extraClass = 'user-avatar') {
    const div = document.createElement('div');
    div.className = extraClass;
    div.style.backgroundColor = color || '#7c6cf0';
    if (avatar) {
        div.style.backgroundImage = `url("${avatar}")`;
    } else {
        div.textContent = username.charAt(0).toUpperCase();
    }
    return div;
}

// ===== Login =====
avatarPick.addEventListener('click', () => avatarInput.click());
avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files[0];
    if (!file) return;
    try {
        pendingAvatar = await shrinkImage(file, 160, 0.8, true);
        avatarPick.style.backgroundImage = `url("${pendingAvatar}")`;
        avatarPick.classList.add('has-photo');
    } catch (e) {
        alert('Could not read that image');
    }
});

joinBtn.addEventListener('click', joinChat);
usernameInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') joinChat();
});

function joinChat() {
    const username = usernameInput.value.trim();
    if (username.length < 2) {
        alert('Name must be at least 2 characters');
        return;
    }
    socket.emit('join', { username, avatar: pendingAvatar });
}

socket.on('join_error', data => alert(data.message));

// ===== Send message / photo =====
function sendMessage(image = '') {
    const message = messageInput.value.trim();
    if (!message && !image) return;
    socket.emit('send_message', { message, image });
    messageInput.value = '';
    messageInput.focus();
}
sendBtn.addEventListener('click', () => sendMessage());
messageInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') sendMessage();
});

attachBtn.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', async () => {
    const file = imageInput.files[0];
    imageInput.value = '';
    if (!file) return;
    try {
        const dataUrl = await shrinkImage(file, 900, 0.75, false);
        sendMessage(dataUrl);
    } catch (e) {
        alert('Could not read that image');
    }
});

// ===== Photo viewer =====
function openLightbox(src) {
    lightboxImg.src = src;
    lightbox.classList.remove('hidden');
}
lightbox.addEventListener('click', () => lightbox.classList.add('hidden'));

// ===== Emoji Picker =====
emojiBtn.addEventListener('click', e => {
    e.stopPropagation();
    emojiPicker.classList.toggle('hidden');
});
document.querySelectorAll('#emoji-picker span').forEach(span => {
    span.addEventListener('click', () => {
        messageInput.value += span.textContent;
        messageInput.focus();
        emojiPicker.classList.add('hidden');
    });
});
document.addEventListener('click', () => emojiPicker.classList.add('hidden'));

// ===== New Room =====
newRoomBtn.addEventListener('click', () => {
    newRoomModal.classList.remove('hidden');
    newRoomName.focus();
});
cancelRoomBtn.addEventListener('click', () => {
    newRoomModal.classList.add('hidden');
    newRoomName.value = '';
});
createRoomBtn.addEventListener('click', () => {
    const name = newRoomName.value.trim();
    if (name) {
        socket.emit('create_room', { name });
        newRoomModal.classList.add('hidden');
        newRoomName.value = '';
    }
});
newRoomName.addEventListener('keypress', e => {
    if (e.key === 'Enter') createRoomBtn.click();
});

// ===== Mobile back =====
backBtn.addEventListener('click', () => sidebar.classList.remove('hidden-mobile'));

// ===== Socket Events =====
socket.on('init_data', data => {
    currentUsername = data.username;
    currentRoom = 'general';

    myAvatarEl.replaceWith(Object.assign(
        makeAvatar(data.username, data.color, data.avatar, 'user-avatar small'),
        { id: 'my-avatar' }
    ));

    loginScreen.classList.add('hidden');
    chatContainer.classList.remove('hidden');

    updateOnlineUsers(data.online_users);
    updateRoomsList(data.rooms);
    renderMessages(data.messages);
    if (window.innerWidth > 768) messageInput.focus();
});

socket.on('receive_message', data => {
    if (data.room === currentRoom) {
        addMessage(data);
    } else {
        unread[data.room] = (unread[data.room] || 0) + 1;
        refreshBadge(data.room);
    }
});

socket.on('user_joined', data => {
    updateOnlineUsers(data.online_users);
    if (currentRoom === 'general') addSystemMessage(data.message, data.time);
});

socket.on('user_left', data => {
    updateOnlineUsers(data.online_users);
    if (currentRoom === 'general') addSystemMessage(data.message, data.time);
});

socket.on('room_switched', data => {
    currentRoom = data.room_id;
    chatTitle.textContent = data.room_name;
    statusEl.textContent = data.room_id.startsWith('private_') ? 'private chat' : 'group chat';
    unread[currentRoom] = 0;
    refreshBadge(currentRoom);
    renderMessages(data.messages);

    document.querySelectorAll('.room-item').forEach(el => {
        el.classList.toggle('active', el.dataset.roomId === currentRoom);
    });

    if (window.innerWidth <= 768) sidebar.classList.add('hidden-mobile');
});

socket.on('room_created', data => addRoomToList(data));

// ===== Helpers =====
function updateOnlineUsers(users) {
    Object.assign(people, users);
    onlineList.innerHTML = '';
    for (const [username, info] of Object.entries(users)) {
        if (username === currentUsername) continue;

        const div = document.createElement('div');
        div.className = 'user-item';
        div.appendChild(makeAvatar(username, info.color, info.avatar));

        const box = document.createElement('div');
        box.className = 'user-info';
        const name = document.createElement('div');
        name.className = 'user-name';
        name.textContent = username;
        const status = document.createElement('div');
        status.className = 'user-status';
        status.textContent = 'online';
        box.append(name, status);
        div.appendChild(box);

        div.addEventListener('click', () => socket.emit('start_private', { username }));
        onlineList.appendChild(div);
    }
}

function updateRoomsList(rooms) {
    roomsList.innerHTML = '';
    rooms.forEach(room => addRoomToList(room));
}

function addRoomToList(room) {
    if (roomsList.querySelector(`[data-room-id="${room.id}"]`)) return;

    const div = document.createElement('div');
    div.className = 'room-item';
    div.dataset.roomId = room.id;
    if (room.id === currentRoom) div.classList.add('active');

    const avatar = document.createElement('div');
    avatar.className = 'room-avatar';
    const p = people[room.name];
    if (room.type === 'private' && p && p.avatar) {
        avatar.style.backgroundImage = `url("${p.avatar}")`;
    } else {
        avatar.textContent = room.name.charAt(0).toUpperCase();
    }

    const info = document.createElement('div');
    info.className = 'room-info';
    const name = document.createElement('div');
    name.className = 'room-name';
    name.textContent = room.name;
    const type = document.createElement('div');
    type.className = 'room-type';
    type.textContent = room.type === 'private' ? 'private' : 'group';
    info.append(name, type);

    div.append(avatar, info);
    div.addEventListener('click', () => socket.emit('switch_room', { room_id: room.id }));
    roomsList.appendChild(div);
}

function refreshBadge(roomId) {
    const item = roomsList.querySelector(`[data-room-id="${roomId}"]`);
    if (!item) return;
    let badge = item.querySelector('.badge');
    const count = unread[roomId] || 0;
    if (!count) { if (badge) badge.remove(); return; }
    if (!badge) {
        badge = document.createElement('div');
        badge.className = 'badge';
        item.appendChild(badge);
    }
    badge.textContent = count > 99 ? '99+' : count;
}

function renderMessages(msgs) {
    messagesDiv.innerHTML = '';
    msgs.forEach(msg => addMessage(msg, false));
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function addMessage(data, scroll = true) {
    const isOwn = data.username === currentUsername;
    const row = document.createElement('div');
    row.className = `msg-row ${isOwn ? 'own' : 'other'}`;

    if (!isOwn) {
        const p = people[data.username] || {};
        row.appendChild(makeAvatar(data.username, data.color, p.avatar));
    }

    const bubble = document.createElement('div');
    bubble.className = 'message';

    const user = document.createElement('div');
    user.className = 'username';
    user.style.color = data.color;
    user.textContent = data.username;
    bubble.appendChild(user);

    if (data.image) {
        const img = document.createElement('img');
        img.className = 'msg-image';
        img.src = data.image;
        img.alt = 'photo';
        img.addEventListener('click', () => openLightbox(data.image));
        img.addEventListener('load', () => {
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        });
        bubble.appendChild(img);
    }

    if (data.message) {
        const text = document.createElement('div');
        text.className = 'text';
        text.textContent = data.message;
        bubble.appendChild(text);
    }

    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = data.time;
    bubble.appendChild(time);

    row.appendChild(bubble);
    messagesDiv.appendChild(row);
    if (scroll) messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function addSystemMessage(text, time) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = `${text} • ${time}`;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}
