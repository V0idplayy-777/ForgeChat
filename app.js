const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

window.addEventListener('error', (event) => {
  console.error('ForgeChat error:', event.error || event.message);
});

const HEARTBEAT_INTERVAL = 25000;
const AWAY_TIMEOUT = 2500;
const TYPING_CLEAR_DELAY = 2500;

const state = {
  user: null,
  profile: null,
  friends: [],
  requests: [],
  selectedFriendId: null,
  presenceMap: {},
  mainChannel: null,
  typingTimers: {},
  myTypingTimer: null,
  heartbeatTimer: null,
  unreadCounts: {},
  streak: 0,
  lastMessageDate: null,
};

const el = {
  authScreen: document.getElementById('auth-screen'),
  appShell: document.getElementById('app-shell'),
  tabSignin: document.getElementById('tab-signin'),
  tabSignup: document.getElementById('tab-signup'),
  signinForm: document.getElementById('signin-form'),
  signupForm: document.getElementById('signup-form'),
  authMessage: document.getElementById('auth-message'),
  currentUsername: document.getElementById('current-username'),
  signoutBtn: document.getElementById('signout-btn'),
  addFriendForm: document.getElementById('add-friend-form'),
  addFriendInput: document.getElementById('add-friend-input'),
  addFriendMessage: document.getElementById('add-friend-message'),
  requestsList: document.getElementById('requests-list'),
  requestCount: document.getElementById('request-count'),
  friendsList: document.getElementById('friends-list'),
  chatEmpty: document.getElementById('chat-empty'),
  chatActive: document.getElementById('chat-active'),
  chatFriendName: document.getElementById('chat-friend-name'),
  chatFriendStatus: document.getElementById('chat-friend-status'),
  removeFriendBtn: document.getElementById('remove-friend-btn'),
  messages: document.getElementById('messages'),
  typingIndicator: document.getElementById('typing-indicator'),
  messageForm: document.getElementById('message-form'),
  messageInput: document.getElementById('message-input'),
  imageInput: document.getElementById('image-input'),
};

const ADMIN_USERNAMES = ['V0idplayy', 'Nikocadoavocado'];

function isAdmin() {
  return state.profile && ADMIN_USERNAMES.includes(state.profile.username);
}

function switchTab(tab) {
  const isSignin = tab === 'signin';
  el.tabSignin.classList.toggle('active', isSignin);
  el.tabSignup.classList.toggle('active', !isSignin);
  el.tabSignin.setAttribute('aria-selected', isSignin);
  el.tabSignup.setAttribute('aria-selected', !isSignin);
  el.signinForm.classList.toggle('hidden', !isSignin);
  el.signupForm.classList.toggle('hidden', isSignin);
  el.authMessage.textContent = '';
}

el.tabSignin.addEventListener('click', () => switchTab('signin'));
el.tabSignup.addEventListener('click', () => switchTab('signup'));

el.signinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('signin-email').value;
  const password = document.getElementById('signin-password').value;
  el.authMessage.textContent = '';
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) el.authMessage.textContent = error.message;
});

el.signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('signup-username').value.trim();
  const email = document.getElementById('signup-email').value;
  const password = document.getElementById('signup-password').value;
  el.authMessage.textContent = '';
  const { error } = await client.auth.signUp({
    email, password,
    options: { data: { username } },
  });
  if (error) { el.authMessage.textContent = error.message; return; }
  el.authMessage.textContent = 'Check your email to confirm, then sign in.';
  switchTab('signin');
});

el.signoutBtn.addEventListener('click', async () => {
  await setMyStatus('offline');
  await client.auth.signOut();
});

document.getElementById('profile-settings-btn').addEventListener('click', openProfileModal);
document.getElementById('modal-close-btn').addEventListener('click', closeProfileModal);
document.getElementById('profile-modal').addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) closeProfileModal();
});
document.getElementById('profile-form').addEventListener('submit', saveProfile);

client.auth.onAuthStateChange((event, session) => {
  if (session?.user) enterApp(session.user);
  else exitApp();
});

async function enterApp(user) {
  state.user = user;
  el.authScreen.classList.add('hidden');
  el.appShell.classList.remove('hidden');

  const { data: profile } = await client
    .from('profiles').select('id, username, streak, last_message_date, avatar_url, bio, status_message')
    .eq('id', user.id).single();
  state.profile = profile;
  state.streak = profile?.streak ?? 0;
  state.lastMessageDate = profile?.last_message_date ?? null;
  el.currentUsername.textContent = profile ? '@' + profile.username : '';
  updateTopBarStatus();
  updateMyProfileDisplay();
  toggleAdminButton();
  await checkAndResetStreak();
  updateStreakDisplay();

  await loadFriends();
  await loadRequests();
  await initPresence();
  subscribeRealtime();
}

function exitApp() {
  state.user = null;
  state.profile = null;
  state.friends = [];
  state.requests = [];
  state.selectedFriendId = null;
  state.presenceMap = {};
  state.streak = 0;
  state.lastMessageDate = null;
  updateStreakDisplay();
  clearInterval(state.heartbeatTimer);
  if (state.mainChannel) { client.removeChannel(state.mainChannel); state.mainChannel = null; }
  el.appShell.classList.add('hidden');
  el.authScreen.classList.remove('hidden');
  el.friendsList.innerHTML = '';
  el.requestsList.innerHTML = '';
  el.messages.innerHTML = '';
  el.chatActive.classList.add('hidden');
  el.chatEmpty.classList.remove('hidden');
}

async function loadFriends() {
  const uid = state.user.id;
  const { data, error } = await client
    .from('friend_requests')
    .select('id, sender_id, receiver_id, sender:sender_id(id,username,avatar_url,status_message), receiver:receiver_id(id,username,avatar_url,status_message)')
    .eq('status', 'accepted')
    .or(`sender_id.eq.${uid},receiver_id.eq.${uid}`);
  if (error) return;
  state.friends = data.map((row) => {
    const friend = row.sender_id === uid ? row.receiver : row.sender;
    return { id: friend.id, username: friend.username, avatar_url: friend.avatar_url, status_message: friend.status_message, rowId: row.id };
  });
  renderFriends();
}

async function loadRequests() {
  const { data, error } = await client
    .from('friend_requests')
    .select('id, sender:sender_id(id,username)')
    .eq('receiver_id', state.user.id)
    .eq('status', 'pending');
  if (error) return;
  state.requests = data;
  renderRequests();
}

function getStatusMeta(status) {
  if (status === 'online')  return { cls: 'status-online',  label: 'Online' };
  if (status === 'away')    return { cls: 'status-away',    label: 'Away' };
  return                           { cls: 'status-offline', label: 'Offline' };
}

function renderFriends() {
  el.friendsList.innerHTML = '';
  state.friends.forEach((friend) => {
    const status = state.presenceMap[friend.id] || 'offline';
    const { cls, label } = getStatusMeta(status);
    const count = state.unreadCounts[friend.id] || 0;
    const li = document.createElement('li');
    li.className = 'friend-item' + (friend.id === state.selectedFriendId ? ' active' : '');
    li.dataset.friendId = friend.id;
    const avatarHtml = friend.avatar_url
      ? `<img class="friend-avatar" src="${friend.avatar_url}" alt="">`
      : `<span class="friend-avatar-letter">${friend.username.charAt(0).toUpperCase()}</span>`;
    const statusMsg = friend.status_message ? `<span class="friend-status-msg">${escapeHtml(friend.status_message)}</span>` : '';
    li.innerHTML = `
      ${avatarHtml}
      <span class="presence-dot ${cls}" title="${label}"></span>
      <span class="friend-name">@${escapeHtml(friend.username)}</span>
      ${statusMsg}
      <span class="friend-status-label ${cls}">${label}</span>
      ${count > 0 ? `<span class="unread-badge">${count}</span>` : ''}
    `;
    li.addEventListener('click', () => selectFriend(friend));
    el.friendsList.appendChild(li);
  });
}

function updateFriendUnreadBadge(friendId) {
  const li = el.friendsList.querySelector(`[data-friend-id="${friendId}"]`);
  if (!li) return;
  const count = state.unreadCounts[friendId] || 0;
  let badge = li.querySelector('.unread-badge');
  if (count > 0) {
    if (badge) {
      badge.textContent = count;
    } else {
      badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = count;
      li.appendChild(badge);
    }
  } else {
    if (badge) badge.remove();
  }
}

function updateFriendPresenceDot(userId) {
  const status = state.presenceMap[userId] || 'offline';
  const { cls, label } = getStatusMeta(status);
  const li = el.friendsList.querySelector(`[data-friend-id="${userId}"]`);
  if (!li) return;
  const dot = li.querySelector('.presence-dot');
  const lbl = li.querySelector('.friend-status-label');
  dot.className = `presence-dot ${cls}`;
  dot.title = label;
  lbl.className = `friend-status-label ${cls}`;
  lbl.textContent = label;
  if (userId === state.selectedFriendId) updateChatHeaderStatus(userId);
}

function updateStreakDisplay() {
  const elStreak = document.getElementById('streak-display');
  if (state.streak > 0) {
    elStreak.textContent = '🔥 ' + state.streak;
    elStreak.style.display = 'inline';
  } else {
    elStreak.textContent = '';
    elStreak.style.display = 'none';
  }
}

function updateTopBarStatus() {
  const statusEl = document.getElementById('current-username');
  if (state.profile) {
    let text = '@' + state.profile.username;
    if (state.profile.status_message) {
      text += ' — ' + state.profile.status_message;
    }
    statusEl.textContent = text;
  }
}

function updateMyProfileDisplay() {
  if (!state.profile) return;
  const avatarEl = document.getElementById('my-profile-avatar');
  if (state.profile.avatar_url) {
    avatarEl.innerHTML = `<img src="${state.profile.avatar_url}" alt="" class="friend-avatar" style="width:32px;height:32px;">`;
  } else {
    avatarEl.innerHTML = state.profile.username.charAt(0).toUpperCase();
    avatarEl.className = 'friend-avatar-letter';
  }
  document.getElementById('my-profile-username').textContent = '@' + state.profile.username;
  document.getElementById('my-profile-status').textContent = state.profile.status_message || '';
  document.getElementById('my-profile-bio').textContent = state.profile.bio || '';
}

function toggleAdminButton() {
  const btn = document.getElementById('admin-panel-btn');
  if (!btn) return;
  btn.classList.toggle('admin-only', !isAdmin());
}

function renderAutocompleteItems(users) {
  const container = document.getElementById('add-friend-autocomplete');
  container.innerHTML = '';
  if (!users || users.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  users.forEach(user => {
    const div = document.createElement('div');
    div.className = 'autocomplete-item';
    const avatar = user.avatar_url
      ? `<img class="friend-avatar" src="${user.avatar_url}" alt="">`
      : `<span class="friend-avatar-letter">${user.username.charAt(0).toUpperCase()}</span>`;
    div.innerHTML = `${avatar} @${user.username}`;
    div.dataset.username = user.username;
    div.addEventListener('click', () => {
      document.getElementById('add-friend-input').value = user.username;
      container.classList.add('hidden');
      document.getElementById('add-friend-form').dispatchEvent(new Event('submit'));
    });
    container.appendChild(div);
  });
}

async function searchUsersForAutocomplete(query) {
  if (!query || query.length < 1) {
    renderAutocompleteItems([]);
    return;
  }
  const uid = state.user.id;
  const friendIds = state.friends.map(f => f.id);
  let request = client
    .from('profiles')
    .select('id, username, avatar_url')
    .ilike('username', `%${query}%`)
    .neq('id', uid);

  if (friendIds.length > 0) {
    request = request.not('id', 'in', `(${friendIds.join(',')})`);
  }

  const { data, error } = await request.limit(10);
  if (error) {
    renderAutocompleteItems([]);
    return;
  }
  renderAutocompleteItems(data || []);
}

async function loadAllUsersForAdmin() {
  if (!isAdmin()) return;
  const { data, error } = await client
    .from('profiles')
    .select('id, username, avatar_url, bio, status_message')
    .order('username');

  if (error) {
    document.getElementById('admin-results').innerHTML = `<div class="admin-empty">Error loading users.</div>`;
    return;
  }

  const { data: emails, error: emailError } = await client.rpc('get_admin_user_emails');

  if (emailError) {
    renderAdminUsers(data || []);
    return;
  }

  const emailMap = Object.fromEntries((emails || []).map(user => [user.id, user.email]));
  renderAdminUsers((data || []).map(user => ({ ...user, email: emailMap[user.id] || 'Unavailable' })));
}

function renderAdminUsers(users) {
  const container = document.getElementById('admin-results');
  if (!users || users.length === 0) {
    container.innerHTML = `<div class="admin-empty">No users found.</div>`;
    return;
  }

  const html = users.map(user => {
    const avatar = user.avatar_url
      ? `<img class="friend-avatar" src="${user.avatar_url}" alt="">`
      : `<span class="friend-avatar-letter">${user.username.charAt(0).toUpperCase()}</span>`;

    const isSelf = state.user?.id === user.id;
    const existingFriend = state.friends.some(friend => friend.id === user.id);

    let button = '';
    if (!isSelf) {
      button = existingFriend
        ? `<button class="admin-friend-btn" type="button" disabled>Friends</button>`
        : `<button class="admin-friend-btn" type="button" data-user-id="${user.id}" data-username="${escapeHtml(user.username)}">Add Friend</button>`;
    }

    return `<div class="admin-user-item">
      ${avatar}
      <div class="admin-user-info">
        <span class="admin-user-name">@${escapeHtml(user.username)}</span>
        <span class="admin-user-email">${escapeHtml(user.email || 'Unavailable')}</span>
        <span class="admin-user-status">${escapeHtml(user.status_message || '')}</span>
        <span class="admin-user-bio">${escapeHtml(user.bio || '')}</span>
      </div>
      ${button}
    </div>`;
  }).join('');

  container.innerHTML = html;

  container.querySelectorAll('.admin-friend-btn:not(:disabled)').forEach(button => {
    button.addEventListener('click', () => sendAdminFriendRequest(button.dataset.userId, button.dataset.username, button));
  });
}

async function sendAdminFriendRequest(userId, username, button) {
  if (!isAdmin() || !userId || userId === state.user.id) return;

  button.disabled = true;
  button.textContent = 'Sending...';

  const { error } = await client.from('friend_requests').insert({
    sender_id: state.user.id,
    receiver_id: userId,
  });

  if (error) {
    button.disabled = false;
    button.textContent = error.code === '23505' ? 'Already Sent' : 'Add Friend';
    return;
  }

  button.textContent = 'Request Sent';
}

async function updateStreakAfterMessage() {
  const today = new Date().toISOString().split('T')[0];
  const lastDate = state.lastMessageDate ? state.lastMessageDate.split('T')[0] : null;
  let newStreak = state.streak;
  let newLastDate = today;
  if (!lastDate || lastDate !== today) {
    const diffDays = lastDate ? Math.floor((new Date(today) - new Date(lastDate)) / (1000 * 60 * 60 * 24)) : null;
    if (diffDays === null || diffDays > 1) {
      newStreak = 1;
    } else if (diffDays === 1) {
      newStreak = state.streak + 1;
    } else {
      newStreak = state.streak;
    }
  }
  if (newStreak !== state.streak || newLastDate !== state.lastMessageDate) {
    state.streak = newStreak;
    state.lastMessageDate = newLastDate;
    await client.from('profiles').update({ streak: newStreak, last_message_date: newLastDate }).eq('id', state.user.id);
    updateStreakDisplay();
  }
}

function updateChatHeaderStatus(userId) {
  const status = state.presenceMap[userId] || 'offline';
  const { cls, label } = getStatusMeta(status);
  el.chatFriendStatus.className = `chat-friend-status ${cls}`;
  el.chatFriendStatus.textContent = label;
}

function renderRequests() {
  el.requestsList.innerHTML = '';
  el.requestCount.textContent = state.requests.length;
  el.requestCount.classList.toggle('hidden', state.requests.length === 0);
  state.requests.forEach((req) => {
    const li = document.createElement('li');
    li.className = 'request-item';
    li.innerHTML = `
      <span>@${req.sender.username}</span>
      <div class="request-actions">
        <button class="btn-accept" type="button">Accept</button>
        <button class="btn-decline" type="button">Decline</button>
      </div>
    `;
    li.querySelector('.btn-accept').addEventListener('click', () => respondRequest(req.id, 'accepted'));
    li.querySelector('.btn-decline').addEventListener('click', () => respondRequest(req.id, 'declined'));
    el.requestsList.appendChild(li);
  });
}

async function respondRequest(id, status) {
  await client.from('friend_requests').update({ status }).eq('id', id);
  await loadRequests();
  if (status === 'accepted') await loadFriends();
}

el.addFriendForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = el.addFriendInput.value.trim();
  el.addFriendMessage.textContent = '';
  if (!username) return;
  if (state.profile && username === state.profile.username) {
    el.addFriendMessage.textContent = "You can't friend yourself!";
    return;
  }
  const { data: target, error: findError } = await client
    .from('profiles').select('id, username').eq('username', username).maybeSingle();
  if (findError || !target) { el.addFriendMessage.textContent = 'No user with that username.'; return; }
  const { error } = await client.from('friend_requests').insert({
    sender_id: state.user.id, receiver_id: target.id,
  });
  if (error) {
    el.addFriendMessage.textContent = error.code === '23505' ? 'Request already exists.' : 'Could not send request.';
    return;
  }
  el.addFriendMessage.textContent = 'Request sent.';
  el.addFriendInput.value = '';
});

el.removeFriendBtn.addEventListener('click', async () => {
  if (!state.selectedFriendId) return;
  const friend = state.friends.find(f => f.id === state.selectedFriendId);
  if (!friend || !confirm(`Remove @${friend.username} as a friend?`)) return;
  await client.from('friend_requests').delete().eq('id', friend.rowId);
  state.selectedFriendId = null;
  el.chatActive.classList.add('hidden');
  el.chatEmpty.classList.remove('hidden');
  await loadFriends();
});

async function selectFriend(friend) {
  state.selectedFriendId = friend.id;
  state.unreadCounts[friend.id] = 0;
  updateFriendUnreadBadge(friend.id);
  el.chatEmpty.classList.add('hidden');
  el.chatActive.classList.remove('hidden');
  el.chatFriendName.textContent = '@' + friend.username;
  const avatarEl = document.getElementById('chat-friend-avatar');
  if (friend.avatar_url) {
    avatarEl.innerHTML = `<img src="${friend.avatar_url}" alt="" class="chat-avatar-img">`;
  } else {
    avatarEl.innerHTML = friend.username.charAt(0).toUpperCase();
    avatarEl.className = 'chat-avatar-letter';
  }

  document.getElementById('chat-friend-status-msg').textContent = friend.status_message || '';
  
  updateChatHeaderStatus(friend.id);
  renderFriends();
  hideTyping(friend.id);
  await loadMessages(friend.id);
}
async function loadMessages(friendId) {
  const uid = state.user.id;
  const { data, error } = await client
    .from('messages')
    .select('id, sender_id, content, image_url, created_at')
    .or(`and(sender_id.eq.${uid},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${uid})`)
    .order('created_at', { ascending: true });
  if (error) return;
  el.messages.innerHTML = '';
  data.forEach(renderMessage);
  el.messages.scrollTop = el.messages.scrollHeight;
}

function renderMessage(msg) {
  const div = document.createElement('div');
  const mine = msg.sender_id === state.user.id;
  div.className = 'message-bubble ' + (mine ? 'message-mine' : 'message-theirs');
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (msg.image_url) {
    div.innerHTML = `<img class="message-img" src="${msg.image_url}" alt="image" loading="lazy"><span class="message-time">${time}</span>`;
  } else {
    div.innerHTML = `<span>${escapeHtml(msg.content)}</span><span class="message-time">${time}</span>`;
  }
  el.messages.appendChild(div);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

el.imageInput.addEventListener('change', async () => {
  const file = el.imageInput.files[0];
  if (!file || !state.selectedFriendId) return;
  el.imageInput.value = '';
  const ext = file.name.split('.').pop();
  const path = `${state.user.id}/${Date.now()}.${ext}`;
  const { error: uploadError } = await client.storage
    .from('chat-images').upload(path, file, { contentType: file.type });
  if (uploadError) { alert('Image upload failed: ' + uploadError.message); return; }
  const { data: urlData } = client.storage.from('chat-images').getPublicUrl(path);
  await client.from('messages').insert({
    sender_id: state.user.id,
    receiver_id: state.selectedFriendId,
    content: '',
    image_url: urlData.publicUrl,
  });
  await updateStreakAfterMessage();
});

el.messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = el.messageInput.value.trim();
  if (!content || !state.selectedFriendId) return;
  el.messageInput.value = '';
  broadcastTyping(false);
  await client.from('messages').insert({
    sender_id: state.user.id,
    receiver_id: state.selectedFriendId,
    content, image_url: null,
  });
  await updateStreakAfterMessage();
});

el.messageInput.addEventListener('input', () => {
  if (!state.selectedFriendId) return;
  broadcastTyping(true);
  clearTimeout(state.myTypingTimer);
  state.myTypingTimer = setTimeout(() => broadcastTyping(false), TYPING_CLEAR_DELAY);
});

function broadcastTyping(isTyping) {
  if (!state.mainChannel || !state.selectedFriendId) return;
  state.mainChannel.send({
    type: 'broadcast',
    event: 'typing',
    payload: {
      from: state.user.id,
      to: state.selectedFriendId,
      typing: isTyping,
    },
  });
}

function showTyping(userId) {
  if (userId !== state.selectedFriendId) return;
  el.typingIndicator.classList.remove('hidden');
  el.messages.scrollTop = el.messages.scrollHeight;
}

function hideTyping(userId) {
  if (userId !== state.selectedFriendId && userId !== undefined) return;
  el.typingIndicator.classList.add('hidden');
}

async function setMyStatus(status) {
  if (!state.user) return;
  await client.from('presence').upsert({
    user_id: state.user.id,
    status,
    last_seen: new Date().toISOString(),
  }, { onConflict: 'user_id' });
}

async function initPresence() {
  await setMyStatus('online');

  const friendIds = state.friends.map(f => f.id);
  if (friendIds.length > 0) {
    const { data } = await client
      .from('presence')
      .select('user_id, status')
      .in('user_id', friendIds);
    if (data) {
      data.forEach(row => { state.presenceMap[row.user_id] = row.status; });
      renderFriends();
    }
  }

  state.heartbeatTimer = setInterval(async () => {
    const status = document.hidden ? 'away' : 'online';
    await setMyStatus(status);
  }, HEARTBEAT_INTERVAL);

  document.addEventListener('visibilitychange', () => {
    setMyStatus(document.hidden ? 'away' : 'online');
  });

  window.addEventListener('beforeunload', () => {
    navigator.sendBeacon(
      `${SUPABASE_URL}/rest/v1/presence?user_id=eq.${state.user.id}`,
      JSON.stringify({ status: 'offline', last_seen: new Date().toISOString() })
    );
  });
}

function subscribeRealtime() {
  state.mainChannel = client
    .channel('forgechat-main')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
  const msg = payload.new;
  const uid = state.user.id;
  if (msg.sender_id !== uid && msg.receiver_id !== uid) return;
  const otherId = msg.sender_id === uid ? msg.receiver_id : msg.sender_id;
  hideTyping(otherId);
  if (otherId === state.selectedFriendId) {
    renderMessage(msg);
    el.messages.scrollTop = el.messages.scrollHeight;
  } else if (msg.sender_id !== uid) {
    if (!state.unreadCounts[otherId]) state.unreadCounts[otherId] = 0;
    state.unreadCounts[otherId] += 1;
    updateFriendUnreadBadge(otherId);
  }
})
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'friend_requests' }, (payload) => {
      if (payload.new.receiver_id === state.user.id) loadRequests();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'friend_requests' }, (payload) => {
      if (payload.new.sender_id === state.user.id || payload.new.receiver_id === state.user.id) {
        loadRequests();
        loadFriends();
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'presence' }, (payload) => {
      const row = payload.new;
      const isFriend = state.friends.some(f => f.id === row.user_id);
      if (!isFriend) return;
      state.presenceMap[row.user_id] = row.status;
      updateFriendPresenceDot(row.user_id);
    })
    .on('broadcast', { event: 'typing' }, (payload) => {
      const { from, to, typing } = payload.payload;
      if (to !== state.user.id) return;
      clearTimeout(state.typingTimers[from]);
      if (typing) {
        showTyping(from);
        state.typingTimers[from] = setTimeout(() => hideTyping(from), TYPING_CLEAR_DELAY + 500);
      } else {
        hideTyping(from);
      }
    })

    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (payload) => {
  const row = payload.new;
  const friend = state.friends.find(f => f.id === row.id);
  if (friend) {
    friend.avatar_url = row.avatar_url;
    friend.status_message = row.status_message;
    renderFriends();
    if (state.selectedFriendId === row.id) {
      const avatarEl = document.getElementById('chat-friend-avatar');
      if (row.avatar_url) {
        avatarEl.innerHTML = `<img src="${row.avatar_url}" alt="" class="chat-avatar-img">`;
      } else {
        avatarEl.innerHTML = row.username ? row.username.charAt(0).toUpperCase() : '?';
        avatarEl.className = 'chat-avatar-letter';
      }
    }
  }
})

    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (payload) => {
      const row = payload.new;
      if (row.id === state.user.id) {
        state.profile.avatar_url = row.avatar_url;
        state.profile.bio = row.bio;
        state.profile.status_message = row.status_message;
        updateMyProfileDisplay();
        updateTopBarStatus();
      }
      const friend = state.friends.find(f => f.id === row.id);
      if (friend) {
        friend.avatar_url = row.avatar_url;
        friend.status_message = row.status_message;
        renderFriends();
        if (state.selectedFriendId === row.id) {
          const avatarEl = document.getElementById('chat-friend-avatar');
          if (row.avatar_url) {
            avatarEl.innerHTML = `<img src="${row.avatar_url}" alt="" class="chat-avatar-img">`;
          } else {
            avatarEl.innerHTML = row.username ? row.username.charAt(0).toUpperCase() : '?';
            avatarEl.className = 'chat-avatar-letter';
          }
          document.getElementById('chat-friend-status-msg').textContent = row.status_message || '';
        }
      }
    })
    .subscribe();
}

function openProfileModal() {
  document.getElementById('profile-modal').classList.remove('hidden');
  if (state.profile) {
    const preview = document.getElementById('profile-avatar-preview');
    if (state.profile.avatar_url) {
      preview.src = state.profile.avatar_url;
      preview.style.display = 'block';
    } else {
      preview.src = '';
      preview.style.display = 'none';
    }
    document.getElementById('profile-bio').value = state.profile.bio || '';
    document.getElementById('profile-status').value = state.profile.status_message || '';
  }
  document.getElementById('profile-message').textContent = '';
  document.getElementById('profile-avatar-upload').value = '';
}

function closeProfileModal() {
  document.getElementById('profile-modal').classList.add('hidden');
}

async function saveProfile(e) {
  e.preventDefault();
  const fileInput = document.getElementById('profile-avatar-upload');
  const bio = document.getElementById('profile-bio').value.trim();
  const status = document.getElementById('profile-status').value.trim();
  const messageEl = document.getElementById('profile-message');
  messageEl.textContent = 'Saving...';

  let avatarUrl = state.profile?.avatar_url || null;

  if (fileInput.files && fileInput.files[0]) {
    const file = fileInput.files[0];
    const ext = file.name.split('.').pop();
    const path = `${state.user.id}/${Date.now()}.${ext}`;
    const { error: uploadError } = await client.storage
      .from('avatars').upload(path, file, { contentType: file.type });
    if (uploadError) {
      messageEl.textContent = 'Avatar upload failed: ' + uploadError.message;
      return;
    }
    const { data: urlData } = client.storage.from('avatars').getPublicUrl(path);
    avatarUrl = urlData.publicUrl;
  }

  const { error } = await client.from('profiles')
    .update({ avatar_url: avatarUrl, bio: bio || null, status_message: status || null })
    .eq('id', state.user.id);
  if (error) {
    messageEl.textContent = 'Error: ' + error.message;
    return;
  }
  if (state.profile) {
    state.profile.avatar_url = avatarUrl;
    state.profile.bio = bio || null;
    state.profile.status_message = status || null;
  }
  updateTopBarStatus();
  updateMyProfileDisplay();
  closeProfileModal();
  messageEl.textContent = 'Profile updated!';
}

document.getElementById('remove-avatar-btn').addEventListener('click', async () => {
  if (!state.profile?.avatar_url) return;
  if (!confirm('Remove your avatar?')) return;
  const { error } = await client.from('profiles')
    .update({ avatar_url: null })
    .eq('id', state.user.id);
  if (error) { alert('Error: ' + error.message); return; }
  state.profile.avatar_url = null;
  updateMyProfileDisplay();
  updateTopBarStatus();
  document.getElementById('profile-avatar-preview').src = '';
  document.getElementById('profile-avatar-preview').style.display = 'none';
});

document.getElementById('my-profile-edit-btn').addEventListener('click', openProfileModal);

document.getElementById('admin-panel-btn').addEventListener('click', openAdminPanel);
document.getElementById('admin-modal-close').addEventListener('click', closeAdminPanel);
document.getElementById('admin-modal').addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) closeAdminPanel();
});

function openAdminPanel() {
  if (!isAdmin()) return;
  document.getElementById('admin-modal').classList.remove('hidden');
  document.getElementById('admin-search-input').value = '';
  loadAllUsersForAdmin();
}

function closeAdminPanel() {
  document.getElementById('admin-modal').classList.add('hidden');
}

async function searchUsers(query) {
  if (!query.trim()) {
    document.getElementById('admin-results').innerHTML = '<p style="color:var(--text-dim);">Enter a search term to find users.</p>';
    return;
  }
  const { data, error } = await client
    .from('profiles')
    .select('id, username, avatar_url, bio, status_message')
    .ilike('username', `%${query}%`)
    .limit(50);
  if (error) {
    document.getElementById('admin-results').innerHTML = '<p style="color:var(--red);">Error: ' + error.message + '</p>';
    return;
  }
  if (!data || data.length === 0) {
    document.getElementById('admin-results').innerHTML = '<p style="color:var(--text-dim);">No users found.</p>';
    return;
  }
  const html = data.map(user => {
    const avatar = user.avatar_url
      ? `<img class="friend-avatar" src="${user.avatar_url}" alt="">`
      : `<span class="friend-avatar-letter">${user.username.charAt(0).toUpperCase()}</span>`;
    return `<div class="admin-user-item">
      ${avatar}
      <div class="admin-user-info">
        <span class="admin-user-name">@${user.username}</span>
        <span class="admin-user-status">${user.status_message || ''}</span>
        <span class="admin-user-bio">${user.bio || ''}</span>
      </div>
    </div>`;
  }).join('');
  document.getElementById('admin-results').innerHTML = html;
}

document.getElementById('add-friend-input').addEventListener('blur', async (e) => {
  const query = e.target.value.trim();

  if (!query) {
    loadAllUsersForAdmin();
    return;
  }

  const { data, error } = await client
    .from('profiles')
    .select('id, username, avatar_url, bio, status_message')
    .ilike('username', `%${query}%`)
    .order('username')
    .limit(50);

  if (error) {
    document.getElementById('admin-results').innerHTML = `<div class="admin-empty">Error searching.</div>`;
    return;
  }

  const { data: emails } = await client.rpc('get_admin_user_emails');
  const emailMap = Object.fromEntries((emails || []).map(user => [user.id, user.email]));

  renderAdminUsers((data || []).map(user => ({
    ...user,
    email: emailMap[user.id] || 'Unavailable'
  })));
});

document.getElementById('add-friend-input').addEventListener('blur', () => {
  setTimeout(() => {
    document.getElementById('add-friend-autocomplete').classList.add('hidden');
  }, 200);
});

let autocompleteTimeout = null;
document.getElementById('add-friend-input').addEventListener('input', (e) => {
  const query = e.target.value.trim();
  clearTimeout(autocompleteTimeout);
  if (!query) {
    document.getElementById('add-friend-autocomplete').classList.add('hidden');
    return;
  }
  autocompleteTimeout = setTimeout(() => searchUsersForAutocomplete(query), 300);
});
