const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const nodemailer = require("nodemailer");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── In-memory store ──
const db = {
  users: [],
  posts: [],
  stories: [],
  messages: {},
  notifications: {},
  history: {},
  comments: {},
  likes: {},
  views: {},
};

// ── Multer storage ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "public/uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) =>
    cb(null, Date.now() + "_" + file.originalname.replace(/\s/g, "_")),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// ══════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════
app.post("/api/auth/register", (req, res) => {
  const { username, phone, password } = req.body;
  if (!username || !phone || !password)
    return res.status(400).json({ error: "All fields required" });

  // Phone: exactly 10 digits
  const phoneClean = String(phone).replace(/\D/g, "");
  if (phoneClean.length !== 10)
    return res
      .status(400)
      .json({ error: "Phone number must be exactly 10 digits" });

  // Password: minimum 6 characters
  if (password.length < 6)
    return res
      .status(400)
      .json({ error: "Password must be at least 6 characters" });

  if (db.users.find((u) => u.username === username))
    return res.status(400).json({ error: "Username taken" });
  if (db.users.find((u) => u.phone === phoneClean))
    return res.status(400).json({ error: "Phone number already registered" });

  const user = {
    id: "u_" + Date.now(),
    username,
    phone: phoneClean,
    password,
    avatar: null,
    bio: "",
    followers: [],
    following: [],
    verified: false,
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  db.history[user.id] = [];
  db.notifications[user.id] = [];
  const { password: _, ...safe } = user;
  res.json({ success: true, user: safe, token: "tok_" + user.id });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  const user = db.users.find(
    (u) => u.username === username && u.password === password
  );
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const { password: _, ...safe } = user;
  res.json({ success: true, user: safe, token: "tok_" + user.id });
});

// ══════════════════════════════════════════
//  USERS
// ══════════════════════════════════════════
app.get("/api/users/:id", (req, res) => {
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  const { password: _, ...safe } = user;
  res.json(safe);
});

app.get("/api/users/search/:q", (req, res) => {
  const q = req.params.q.toLowerCase();
  const results = db.users
    .filter((u) => u.username.toLowerCase().includes(q))
    .map(({ password: _, ...u }) => u);
  res.json(results);
});

app.post("/api/users/:id/follow", (req, res) => {
  const { followerId } = req.body;
  const target = db.users.find((u) => u.id === req.params.id);
  const follower = db.users.find((u) => u.id === followerId);
  if (!target || !follower) return res.status(404).json({ error: "Not found" });
  if (!target.followers.includes(followerId)) {
    target.followers.push(followerId);
    follower.following.push(req.params.id);
    pushNotification(req.params.id, {
      type: "follow",
      from: followerId,
      fromUsername: follower.username,
      message: `${follower.username} started following you`,
    });
  }
  res.json({ success: true });
});

app.post("/api/users/:id/unfollow", (req, res) => {
  const { followerId } = req.body;
  const target = db.users.find((u) => u.id === req.params.id);
  const follower = db.users.find((u) => u.id === followerId);
  if (!target || !follower) return res.status(404).json({ error: "Not found" });
  target.followers = target.followers.filter((f) => f !== followerId);
  follower.following = follower.following.filter((f) => f !== req.params.id);
  res.json({ success: true });
});

app.put("/api/users/:id/profile", upload.single("avatar"), (req, res) => {
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  if (req.body.bio !== undefined) user.bio = req.body.bio;
  if (req.body.username) user.username = req.body.username;
  if (req.file) user.avatar = "/uploads/" + req.file.filename;
  const { password: _, ...safe } = user;
  res.json(safe);
});

// ══════════════════════════════════════════
//  POSTS
// ══════════════════════════════════════════
app.post("/api/posts", upload.single("media"), (req, res) => {
  const { userId, caption } = req.body;
  const user = db.users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  const postId = Date.now().toString();
  const post = {
    id: "p_" + postId,
    shortId: postId,
    userId,
    username: user.username,
    avatar: user.avatar,
    caption: caption || "",
    media: req.file ? "/uploads/" + req.file.filename : null,
    mediaType: req.file
      ? req.file.mimetype.startsWith("video")
        ? "video"
        : req.file.mimetype.startsWith("audio")
        ? "audio"
        : "image"
      : null,
    likes: [],
    comments: [],
    saves: [],
    views: [],
    createdAt: new Date().toISOString(),
  };
  db.posts.unshift(post);
  user.followers.forEach((fId) => {
    pushNotification(fId, {
      type: "post",
      from: userId,
      fromUsername: user.username,
      postId: post.id,
      message: `${user.username} shared a new post`,
    });
  });
  io.emit("new_post", post);
  res.json(post);
});

app.get("/api/posts/feed/:userId", (req, res) => {
  const user = db.users.find((u) => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error: "Not found" });
  const feed = db.posts.filter(
    (p) => user.following.includes(p.userId) || p.userId === req.params.userId
  );
  res.json(feed);
});

app.get("/api/posts/explore", (req, res) => {
  res.json([...db.posts].sort(() => Math.random() - 0.5).slice(0, 20));
});

app.get("/api/posts/user/:userId", (req, res) => {
  res.json(db.posts.filter((p) => p.userId === req.params.userId));
});

// Get post by shortId for URL sharing
app.get("/api/posts/byshort/:shortId", (req, res) => {
  const post = db.posts.find((p) => p.shortId === req.params.shortId);
  if (!post) return res.status(404).json({ error: "Not found" });
  res.json(post);
});

// Get user by phone number for profile URL
app.get("/api/users/byphone/:phone", (req, res) => {
  const user = db.users.find((u) => u.phone === req.params.phone);
  if (!user) return res.status(404).json({ error: "Not found" });
  const { password: _, ...safe } = user;
  res.json(safe);
});

app.post("/api/posts/:id/like", (req, res) => {
  const { userId } = req.body;
  const post = db.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: "Not found" });
  if (post.likes.includes(userId)) {
    post.likes = post.likes.filter((l) => l !== userId);
  } else {
    post.likes.push(userId);
    const liker = db.users.find((u) => u.id === userId);
    if (post.userId !== userId) {
      pushNotification(post.userId, {
        type: "like",
        from: userId,
        fromUsername: liker?.username,
        postId: post.id,
        message: `${liker?.username} liked your post`,
      });
    }
  }
  io.emit("post_updated", post);
  res.json(post);
});

app.post("/api/posts/:id/view", (req, res) => {
  const { userId } = req.body;
  const post = db.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: "Not found" });
  if (!post.views) post.views = [];
  if (!post.views.includes(userId)) {
    post.views.push(userId);
  }
  res.json({ success: true, views: post.views.length });
});

app.post("/api/posts/:id/comment", (req, res) => {
  const { userId, text, replyTo } = req.body;
  const post = db.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: "Not found" });
  const commenter = db.users.find((u) => u.id === userId);
  const comment = {
    id: "c_" + Date.now(),
    userId,
    username: commenter?.username,
    avatar: commenter?.avatar,
    text,
    replyTo: replyTo || null,
    replies: [],
    likes: [],
    createdAt: new Date().toISOString(),
  };
  if (replyTo) {
    const parent = post.comments.find((c) => c.id === replyTo);
    if (parent) {
      if (!parent.replies) parent.replies = [];
      parent.replies.push(comment);
    } else {
      post.comments.push(comment);
    }
  } else {
    post.comments.push(comment);
  }
  if (post.userId !== userId) {
    pushNotification(post.userId, {
      type: "comment",
      from: userId,
      fromUsername: commenter?.username,
      postId: post.id,
      message: `${commenter?.username} commented: ${text.slice(0, 40)}`,
    });
  }
  io.emit("post_updated", post);
  res.json(post);
});

app.post("/api/posts/:id/save", (req, res) => {
  const { userId } = req.body;
  const post = db.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: "Not found" });
  if (post.saves.includes(userId)) {
    post.saves = post.saves.filter((s) => s !== userId);
  } else {
    post.saves.push(userId);
  }
  res.json(post);
});

app.get("/api/posts/saved/:userId", (req, res) => {
  const saved = db.posts.filter(
    (p) => p.saves && p.saves.includes(req.params.userId)
  );
  res.json(saved);
});

app.delete("/api/posts/:id", (req, res) => {
  const { userId } = req.body;
  const idx = db.posts.findIndex(
    (p) => p.id === req.params.id && p.userId === userId
  );
  if (idx === -1) return res.status(403).json({ error: "Forbidden" });
  db.posts.splice(idx, 1);
  io.emit("post_deleted", req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════
//  STORIES
// ══════════════════════════════════════════
app.post("/api/stories", upload.single("media"), (req, res) => {
  const { userId } = req.body;
  const user = db.users.find((u) => u.id === userId);
  const story = {
    id: "s_" + Date.now(),
    userId,
    username: user?.username,
    avatar: user?.avatar,
    media: req.file ? "/uploads/" + req.file.filename : null,
    mediaType: req.file
      ? req.file.mimetype.startsWith("video")
        ? "video"
        : "image"
      : null,
    views: [],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  db.stories.push(story);
  io.emit("new_story", story);
  res.json(story);
});

app.get("/api/stories", (req, res) => {
  const now = new Date();
  res.json(db.stories.filter((s) => new Date(s.expiresAt) > now));
});

app.post("/api/stories/:id/view", (req, res) => {
  const { userId } = req.body;
  const story = db.stories.find((s) => s.id === req.params.id);
  if (story && !story.views.includes(userId)) story.views.push(userId);
  res.json({ success: true });
});

// ══════════════════════════════════════════
//  MESSAGES (DM)
// ══════════════════════════════════════════
app.get("/api/messages/:userId/:otherUserId", (req, res) => {
  const key = [req.params.userId, req.params.otherUserId].sort().join("_");
  res.json(db.messages[key] || []);
});

app.get("/api/conversations/:userId", (req, res) => {
  const uid = req.params.userId;
  const convs = [];
  Object.keys(db.messages).forEach((key) => {
    if (key.includes(uid)) {
      const other = db.users.find((u) => u.id !== uid && key.includes(u.id));
      const msgs = db.messages[key];
      if (msgs.length && other) {
        const { password: _, ...safeOther } = other;
        convs.push({
          user: safeOther,
          lastMessage: msgs[msgs.length - 1],
          unread: msgs.filter((m) => m.to === uid && !m.read).length,
        });
      }
    }
  });
  convs.sort(
    (a, b) =>
      new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt)
  );
  res.json(convs);
});

// ══════════════════════════════════════════
//  HISTORY
// ══════════════════════════════════════════
app.post("/api/history", (req, res) => {
  const { userId, action, targetId, targetType, meta } = req.body;
  if (!db.history[userId]) db.history[userId] = [];
  const entry = {
    id: "h_" + Date.now(),
    action,
    targetId,
    targetType,
    meta: meta || {},
    createdAt: new Date().toISOString(),
  };
  db.history[userId].unshift(entry);
  if (db.history[userId].length > 200)
    db.history[userId] = db.history[userId].slice(0, 200);
  res.json(entry);
});

app.get("/api/history/:userId", (req, res) => {
  res.json(db.history[req.params.userId] || []);
});

app.delete("/api/history/:userId", (req, res) => {
  db.history[req.params.userId] = [];
  res.json({ success: true });
});

app.delete("/api/history/:userId/:entryId", (req, res) => {
  if (db.history[req.params.userId]) {
    db.history[req.params.userId] = db.history[req.params.userId].filter(
      (e) => e.id !== req.params.entryId
    );
  }
  res.json({ success: true });
});

// ══════════════════════════════════════════
//  NOTIFICATIONS
// ══════════════════════════════════════════
app.get("/api/notifications/:userId", (req, res) => {
  res.json(db.notifications[req.params.userId] || []);
});

app.post("/api/notifications/:userId/read", (req, res) => {
  if (db.notifications[req.params.userId]) {
    db.notifications[req.params.userId].forEach((n) => (n.read = true));
  }
  res.json({ success: true });
});

// ══════════════════════════════════════════
//  BUG REPORT
// ══════════════════════════════════════════
app.post("/api/bug-report", async (req, res) => {
  const { description, steps, userId } = req.body;
  console.log("Bug Report received:", {
    description,
    steps,
    userId,
    time: new Date().toISOString(),
  });
  try {
    const transporter = nodemailer.createTransporter({
      service: "gmail",
      auth: { user: "noreply@spark.app", pass: process.env.MAIL_PASS || "" },
    });
    await transporter.sendMail({
      from: "noreply@spark.app",
      to: "skarts433@gmail.com",
      subject: "Spark Bug Report",
      text: `Bug Report\n\nDescription: ${description}\n\nSteps: ${
        steps || "N/A"
      }\n\nUser ID: ${
        userId || "Unknown"
      }\n\nTime: ${new Date().toISOString()}`,
    });
  } catch (e) {
    console.log("Email not sent (mail not configured):", e.message);
  }
  res.json({ success: true });
});

// ══════════════════════════════════════════
//  HELPER
// ══════════════════════════════════════════
function pushNotification(userId, data) {
  if (!db.notifications[userId]) db.notifications[userId] = [];
  const notif = {
    id: "n_" + Date.now(),
    ...data,
    read: false,
    createdAt: new Date().toISOString(),
  };
  db.notifications[userId].unshift(notif);
  if (db.notifications[userId].length > 100)
    db.notifications[userId] = db.notifications[userId].slice(0, 100);
  io.to(userId).emit("notification", notif);
}

// ══════════════════════════════════════════
//  SITEMAPS
// ══════════════════════════════════════════
app.get("/sitemap.xml", (req, res) => {
  const host = req.protocol + "://" + req.get("host");
  const now = new Date().toISOString().split("T")[0];
  const sitemaps = [
    `<sitemap><loc>${host}/sitemap-posts.xml</loc><lastmod>${now}</lastmod></sitemap>`,
    `<sitemap><loc>${host}/sitemap-profiles.xml</loc><lastmod>${now}</lastmod></sitemap>`,
    `<sitemap><loc>${host}/sitemap-explore.xml</loc><lastmod>${now}</lastmod></sitemap>`,
    `<sitemap><loc>${host}/sitemap-feed.xml</loc><lastmod>${now}</lastmod></sitemap>`,
    `<sitemap><loc>${host}/sitemap-messages.xml</loc><lastmod>${now}</lastmod></sitemap>`,
    `<sitemap><loc>${host}/sitemap-notifications.xml</loc><lastmod>${now}</lastmod></sitemap>`,
    `<sitemap><loc>${host}/sitemap-history.xml</loc><lastmod>${now}</lastmod></sitemap>`,
    `<sitemap><loc>${host}/sitemap-widgets.xml</loc><lastmod>${now}</lastmod></sitemap>`,
  ];
  res.set("Content-Type", "application/xml");
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemaps.join(
      ""
    )}</sitemapindex>`
  );
});

app.get("/sitemap-posts.xml", (req, res) => {
  const host = req.protocol + "://" + req.get("host");
  const urls = db.posts.map((p) => {
    const loc = `${host}/post/${p.shortId}`;
    const lastmod = p.createdAt.split("T")[0];
    const image = p.media
      ? `<image:image><image:loc>${host}${p.media}</image:loc><image:title>${(
          p.caption || "Spark post by " + p.username
        ).replace(/[<>&'"]/g, "")}</image:title><image:caption>Posted by ${
          p.username
        } on Spark</image:caption></image:image>`
      : "";
    return `<url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>${image}</url>`;
  });
  res.set("Content-Type", "application/xml");
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${urls.join(
      ""
    )}</urlset>`
  );
});

app.get("/sitemap-profiles.xml", (req, res) => {
  const host = req.protocol + "://" + req.get("host");
  const urls = db.users.map((u) => {
    const loc = `${host}/profile/${encodeURIComponent(u.phone)}`;
    const lastmod = u.createdAt.split("T")[0];
    const image = u.avatar
      ? `<image:image><image:loc>${host}${u.avatar}</image:loc><image:title>${u.username} on Spark</image:title></image:image>`
      : "";
    return `<url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority>${image}</url>`;
  });
  res.set("Content-Type", "application/xml");
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${urls.join(
      ""
    )}</urlset>`
  );
});

const tabSitemaps = {
  explore: "/?tab=explore",
  feed: "/",
  messages: "/?tab=messages",
  notifications: "/?tab=notifications",
  history: "/?tab=history",
  widgets: "/?tab=widgets",
};
Object.entries(tabSitemaps).forEach(([tab, urlPath]) => {
  app.get(`/sitemap-${tab}.xml`, (req, res) => {
    const host = req.protocol + "://" + req.get("host");
    res.set("Content-Type", "application/xml");
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${host}${urlPath}</loc><changefreq>daily</changefreq><priority>0.7</priority></url></urlset>`
    );
  });
});

// ══════════════════════════════════════════
//  PAGE ROUTES
// ══════════════════════════════════════════
app.get("/post/:shortId", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});
app.get("/profile/:phone", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});
app.get("/:phone([0-9+]{7,15})", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// ══════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════
const onlineUsers = {};

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("user_online", (userId) => {
    onlineUsers[userId] = socket.id;
    socket.userId = userId;
    socket.join(userId);
    io.emit("online_users", Object.keys(onlineUsers));
  });

  socket.on("send_message", (data) => {
    const { from, to, text, media, mediaType, fileName } = data;
    const key = [from, to].sort().join("_");
    if (!db.messages[key]) db.messages[key] = [];
    const fromUser = db.users.find((u) => u.id === from);
    const msg = {
      id: "m_" + Date.now(),
      from,
      to,
      text: text || "",
      media: media || null,
      mediaType: mediaType || null,
      fileName: fileName || null,
      read: false,
      createdAt: new Date().toISOString(),
    };
    db.messages[key].push(msg);

    io.to(from).emit("new_message", msg);
    io.to(to).emit("new_message", {
      ...msg,
      senderName: fromUser?.username,
      senderAvatar: fromUser?.avatar,
    });

    pushNotification(to, {
      type: "message",
      from,
      fromUsername: fromUser?.username,
      fromAvatar: fromUser?.avatar,
      message: text || (media ? "📎 Attachment" : ""),
    });
  });

  socket.on("mark_read", ({ from, to }) => {
    const key = [from, to].sort().join("_");
    if (db.messages[key]) {
      db.messages[key].forEach((m) => {
        if (m.to === from) m.read = true;
      });
    }
    io.to(to).emit("messages_read");
  });

  socket.on("typing", ({ from, to }) => {
    io.to(to).emit("user_typing", { from });
  });

  socket.on("stop_typing", ({ from, to }) => {
    io.to(to).emit("user_stop_typing", { from });
  });

  // WebRTC call signaling
  socket.on("call_offer", (data) => {
    const fromUser = db.users.find((u) => u.id === data.from);
    io.to(data.to).emit("incoming_call", {
      ...data,
      fromUsername: fromUser?.username,
      fromAvatar: fromUser?.avatar,
    });
  });

  socket.on("call_answer", (data) => {
    io.to(data.to).emit("call_answered", data);
  });

  socket.on("call_ice_candidate", (data) => {
    io.to(data.to).emit("ice_candidate", data);
  });

  socket.on("call_end", (data) => {
    io.to(data.to).emit("call_ended");
  });

  socket.on("call_reject", (data) => {
    io.to(data.to).emit("call_rejected");
  });

  socket.on("disconnect", () => {
    if (socket.userId) {
      delete onlineUsers[socket.userId];
      io.emit("online_users", Object.keys(onlineUsers));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Spark running on http://localhost:${PORT}`)
);
