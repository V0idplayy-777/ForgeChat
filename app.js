const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const state = {
  user: null,
  profile: null,
  friends: [],
  requests: [],
  selectedFriendId: null,
  messagesChannel: null,
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
  removeFriendBtn: document.getElementById('remove-friend-btn'),
  messages: document.getElementById('messages'),
  messageForm: document.getElementById('message-form'),
  messageInput: document.getElementById('message-input'),
  imageInput: document.getElementById('image-input'),
  sparks: document.getElementById('sparks'),
};

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
    email,
    password,
    options: { data: { username } },
  });
  if (error) {
    el.authMessage.textContent = error.message;
    return;
  }
  el.authMessage.textContent = 'Check your email to confirm, then sign in.';
  switchTab('signin');
});

el.signoutBtn.addEventListener('click', async () => {
  await client.auth.signOut();
});

client.auth.onAuthStateChange((event, session) => {
  if (session?.user) {
    enterApp(session.user);
  } else {
    exitApp();
  }
});

async function enterApp(user) {
  state.user = user;
  el.authScreen.classList.add('hidden');
  el.appShell.classList.remove('hidden');

  const { data: profile } = await client
    .from('profiles')
    .select('id, username')
    .eq('id', user.id)
    .single();
  state.profile = profile;
  el.currentUsername.textContent = profile ? '@' + profile.username : '';

  await loadFriends();
  await loadRequests();
  subscribeRealtime();
}

function exitApp() {
  state.user = null;
  state.profile = null;
  state.friends = [];
  state.requests = [];
  state.selectedFriendId = null;
  if (state.messagesChannel) {
    client.removeChannel(state.messagesChannel);
    state.messagesChannel = null;
  }
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
    .select('id, sender_id, receiver_id, sender:sender_id(id,username), receiver:receiver_id(id,username)')
    .eq('status', 'accepted')
    .or(`sender_id.eq.${uid},receiver_id.eq.${uid}`);

  if (error) return;

  state.friends = data.map((row) => {
    const friend = row.sender_id === uid ? row.receiver : row.sender;
    return { id: friend.id, username: friend.username, rowId: row.id };
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

function renderFriends() {
  el.friendsList.innerHTML = '';
  state.friends.forEach((friend) => {
    const li = document.createElement('li');
    li.className = 'friend-item' + (friend.id === state.selectedFriendId ? ' active' : '');
    li.innerHTML = `<span class="friend-dot"></span><span>@${friend.username}</span>`;
    li.addEventListener('click', () => selectFriend(friend));
    el.friendsList.appendChild(li);
  });
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
    el.addFriendMessage.textContent = "You can't friend yourself.";
    return;
  }

  const { data: target, error: findError } = await client
    .from('profiles')
    .select('id, username')
    .eq('username', username)
    .maybeSingle();

  if (findError || !target) {
    el.addFriendMessage.textContent = 'No user with that username.';
    return;
  }

  const { error } = await client.from('friend_requests').insert({
    sender_id: state.user.id,
    receiver_id: target.id,
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
  if (!friend) return;
  if (!confirm(`Remove @${friend.username} as a friend?`)) return;

  await client
    .from('friend_requests')
    .delete()
    .eq('id', friend.rowId);

  state.selectedFriendId = null;
  el.chatActive.classList.add('hidden');
  el.chatEmpty.classList.remove('hidden');
  await loadFriends();
});

async function selectFriend(friend) {
  state.selectedFriendId = friend.id;
  el.chatEmpty.classList.add('hidden');
  el.chatActive.classList.remove('hidden');
  el.chatFriendName.textContent = '@' + friend.username;
  renderFriends();
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
    .from('chat-images')
    .upload(path, file, { contentType: file.type });

  if (uploadError) {
    alert('Image upload failed: ' + uploadError.message);
    return;
  }

  const { data: urlData } = client.storage.from('chat-images').getPublicUrl(path);

  await client.from('messages').insert({
    sender_id: state.user.id,
    receiver_id: state.selectedFriendId,
    content: '',
    image_url: urlData.publicUrl,
  });
});

el.messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = el.messageInput.value.trim();
  if (!content || !state.selectedFriendId) return;
  el.messageInput.value = '';
  await client.from('messages').insert({
    sender_id: state.user.id,
    receiver_id: state.selectedFriendId,
    content,
    image_url: null,
  });
});

function subscribeRealtime() {
  state.messagesChannel = client
    .channel('forgechat-realtime')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      const msg = payload.new;
      const uid = state.user.id;
      const involvesMe = msg.sender_id === uid || msg.receiver_id === uid;
      if (!involvesMe) return;
      const otherId = msg.sender_id === uid ? msg.receiver_id : msg.sender_id;
      if (otherId === state.selectedFriendId) {
        renderMessage(msg);
        el.messages.scrollTop = el.messages.scrollHeight;
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
    .subscribe();
}
