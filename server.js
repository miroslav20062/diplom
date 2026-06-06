const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const fs = require('fs');
const csv = require('csv-parser');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

const app = express();
const PORT = process.env.PORT || 3000;  // ← ТОЛЬКО ОДИН РАЗ
const HOST = '0.0.0.0';                 // ← ДОБАВЛЯЕМ HOST

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Подключение к SQLite
const db = new Database('./database.db');

// Создание таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'client'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT,
        price INTEGER NOT NULL,
        image TEXT,
        stock INTEGER DEFAULT 100
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cart (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        quantity INTEGER DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        order_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'новый',
        total_amount INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        price_at_time INTEGER NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
    )`);
});

// Импорт CSV при запуске
function importCSVIfNeeded() {
    db.get('SELECT COUNT(*) as count FROM products', (err, row) => {
        if (row && row.count === 0 && fs.existsSync('./products.csv')) {
            console.log('Импорт товаров из CSV...');
            const products = [];
            fs.createReadStream('./products.csv')
                .pipe(csv())
                .on('data', (row) => {
                    if (!row.Name) return;
                    products.push({
                        name: row.Name.replace(/"/g, ''),
                        category: row.Category.toLowerCase(),
                        price: parseInt(row.Price) || 0,
                        description: row.Description || '',
                        image: 'https://via.placeholder.com/300'
                    });
                })
                .on('end', () => {
                    const stmt = db.prepare(`INSERT INTO products (name, category, price, description, image, stock) 
                                             VALUES (?, ?, ?, ?, ?, 100)`);
                    products.forEach(p => stmt.run(p.name, p.category, p.price, p.description, p.image));
                    stmt.finalize();
                    console.log(`Импортировано ${products.length} товаров`);
                });
        }
    });
}

setTimeout(importCSVIfNeeded, 1000);

// ========== API РОУТЫ ==========

// Товары
app.get('/api/products', (req, res) => {
    const { category, search } = req.query;
    let query = 'SELECT * FROM products';
    const params = [];
    
    if (category && category !== 'all') {
        query += ' WHERE category = ?';
        params.push(category);
    }
    if (search) {
        query += params.length ? ' AND' : ' WHERE';
        query += ' (name LIKE ? OR description LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }
    
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/products/:id', (req, res) => {
    db.get('SELECT * FROM products WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Товар не найден' });
        res.json(row);
    });
});

app.post('/api/products', (req, res) => {
    const { name, category, price, description, image } = req.body;
    db.run('INSERT INTO products (name, category, price, description, image, stock) VALUES (?, ?, ?, ?, ?, 100)',
        [name, category, price, description, image || 'https://via.placeholder.com/300'],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        });
});

// Пользователи
app.post('/api/register', async (req, res) => {
    const { name, email, password, role } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    db.run('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
        [name, email, hashedPassword, role || 'client'],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: 'Email уже зарегистрирован' });
                }
                return res.status(500).json({ error: err.message });
            }
            res.json({ id: this.lastID, name, email, role });
        });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Неверный email или пароль' });
        
        res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
    });
});

// Корзина
app.get('/api/cart/:userId', (req, res) => {
    db.all(`SELECT c.*, p.name, p.price, p.image 
            FROM cart c 
            JOIN products p ON c.product_id = p.id 
            WHERE c.user_id = ?`, [req.params.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/cart', (req, res) => {
    const { user_id, product_id, quantity } = req.body;
    db.get('SELECT * FROM cart WHERE user_id = ? AND product_id = ?', [user_id, product_id], (err, row) => {
        if (row) {
            db.run('UPDATE cart SET quantity = quantity + ? WHERE user_id = ? AND product_id = ?',
                [quantity, user_id, product_id],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true });
                });
        } else {
            db.run('INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)',
                [user_id, product_id, quantity],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true });
                });
        }
    });
});

app.delete('/api/cart/:userId/:productId', (req, res) => {
    db.run('DELETE FROM cart WHERE user_id = ? AND product_id = ?',
        [req.params.userId, req.params.productId],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

app.delete('/api/cart/:userId', (req, res) => {
    db.run('DELETE FROM cart WHERE user_id = ?', [req.params.userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Заказы
app.post('/api/orders', (req, res) => {
    const { user_id } = req.body;
    
    db.all(`SELECT c.product_id, c.quantity, p.price, p.stock 
            FROM cart c 
            JOIN products p ON c.product_id = p.id 
            WHERE c.user_id = ?`, [user_id], (err, cartItems) => {
        if (err) return res.status(500).json({ error: err.message });
        if (cartItems.length === 0) return res.status(400).json({ error: 'Корзина пуста' });
        
        for (let item of cartItems) {
            if (item.quantity > item.stock) {
                return res.status(400).json({ error: `Недостаточно товара на складе` });
            }
        }
        
        const total = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            
            db.run('INSERT INTO orders (user_id, total_amount, status) VALUES (?, ?, ?)',
                [user_id, total, 'новый'], function(err) {
                    if (err) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: err.message });
                    }
                    
                    const orderId = this.lastID;
                    const stmt = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price_at_time) VALUES (?, ?, ?, ?)');
                    for (let item of cartItems) {
                        stmt.run(orderId, item.product_id, item.quantity, item.price);
                        db.run('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, item.product_id]);
                    }
                    stmt.finalize();
                    
                    db.run('DELETE FROM cart WHERE user_id = ?', [user_id], (err) => {
                        if (err) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: err.message });
                        }
                        
                        db.run('COMMIT');
                        res.json({ orderId, total, message: 'Заказ успешно оформлен' });
                    });
                });
        });
    });
});

app.get('/api/orders', (req, res) => {
    const { user_id, role } = req.query;
    
    let query = `
        SELECT o.id, o.user_id, u.name as user_name, u.email, o.order_date, o.status, o.total_amount
        FROM orders o
        JOIN users u ON o.user_id = u.id
    `;
    const params = [];
    
    if (role !== 'manager') {
        query += ' WHERE o.user_id = ?';
        params.push(user_id);
    }
    
    query += ' ORDER BY o.order_date DESC';
    
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/orders/:id/items', (req, res) => {
    db.all(`SELECT oi.*, p.name, p.image 
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            WHERE oi.order_id = ?`, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.patch('/api/orders/:id/status', (req, res) => {
    const { status } = req.body;
    const validStatuses = ['новый', 'в обработке', 'готов к выдаче', 'выполнен', 'отменён'];
    
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Недопустимый статус' });
    }
    
    db.run('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Заказ не найден' });
        res.json({ success: true });
    });
});

// Экспорт/импорт CSV
app.get('/api/export/csv', (req, res) => {
    db.all('SELECT id, name, category, price, description FROM products', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        let csv = 'ID,Name,Category,Price,Description\n';
        rows.forEach(p => {
            csv += `${p.id},"${p.name}",${p.category},${p.price},"${p.description || ''}"\n`;
        });
        
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=products.csv');
        res.send('\ufeff' + csv);
    });
});

app.post('/api/import/csv', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    
    const products = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (row) => {
            if (!row.Name) return;
            products.push([
                row.Name.replace(/"/g, ''),
                row.Category.toLowerCase(),
                parseInt(row.Price) || 0,
                row.Description || ''
            ]);
        })
        .on('end', () => {
            const stmt = db.prepare('INSERT OR IGNORE INTO products (name, category, price, description, image, stock) VALUES (?, ?, ?, ?, ?, 100)');
            products.forEach(p => stmt.run(p[0], p[1], p[2], p[3], 'https://via.placeholder.com/300'));
            stmt.finalize();
            fs.unlinkSync(req.file.path);
            res.json({ success: true, count: products.length });
        });
});

// ========== ЗАПУСК СЕРВЕРА ==========
app.listen(PORT, HOST, () => {
    console.log(`✅ Сервер запущен:`);
    console.log(`   - Локально: http://localhost:${PORT}`);
    console.log(`   - Для туннеля: http://0.0.0.0:${PORT}`);
});
