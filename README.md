# AsiePay · تتبع خطوط المكاتب

نظام Node لتتبع الخطوط المسلّمة للمكاتب ومطابقتها مع تفعيلات آسيا.

## التدفق

1. رفع **ملف التجهيز** → كل رقم يُربط بنقطة البيع (`Customer`) بحالة `ASSIGNED` (غير مباع)
2. رفع **ملف آسيا** → مطابقة الرقم وتحديث `ACTIVATED` + تاريخ التفعيل + مدة البيع بالأيام
3. لوحة المكاتب: مستلم / مباع / غير مباع / نسبة البيع / آخر تفعيل

## التشغيل

```bash
cp .env.example .env   # ثم عدّل بيانات MariaDB
npm install
npm start
```

افتح http://localhost:3847

تعبئة من الملفات المحلية:

```bash
npm run seed
```

## قاعدة البيانات (MariaDB)

على استضافة cPanel (مثل itf-iraq.com) ضع في `.env`:

```env
DB_DRIVER=mariadb
DB_HOST=localhost
DB_PORT=3306
DB_USER=htadaorg_asia
DB_PASSWORD=***
DB_NAME=htadaorg_asia
```

للتطوير المحلي بدون MariaDB:

```env
DB_DRIVER=sqlite
```

> Vercel غير مناسب لهذا المشروع. شغّل التطبيق عبر Node.js App في cPanel على نفس السيرفر مع `DB_HOST=localhost`.

## تسجيل الدخول

- **أدمن:** `admin` / `Admin@123`
- المندوب: يُنشأ من تبويب المندوبون
- المندوب يطلب تجهيز من تبويب **طلبات التجهيز**
- الأدمن يراجع الطلبات (قبول / رفض / تم التجهيز)

```text
GET /api/offices/:id/export.csv?status=all|unsold|activated
```
