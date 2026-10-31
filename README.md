# Capacitor Android Builder 🚀

ابزار بصری (GUI) و خط فرمان (CLI) برای بیلد، نسخه‌گذاری، امضای APK و انتشار آپدیت‌های زنده در اپلیکیشن‌های **Capacitor** با پشتیبانی کامل از **کافه‌بازار** و **مایکت**.

---

## قابلیت‌ها

- 🎨 **محیط بصری ساده و قدرتمند:** تنظیم نام برنامه، شناسه پکیج (Application ID)، نسخه‌گذاری SemVer (x.y.z)، آیکون‌های Adaptive، جهت صفحه (Portrait/Landscape).
- 🏬 **پشتیبانی از استورهای ایرانی:** طعم‌های بیلد مجزا برای کافه‌بازار (Poolakey) و مایکت (Myket In-App Billing) بدون تداخل کدهای استورها.
- 🔑 **مدیریت امن کلیدهای امضا (Keystore):** امکان بارگذاری و بررسی کلید امضای رسمی، بدون قرار گرفتن پسوردها در Git.
- ⚡ **سیستم آپدیت زنده (Live Updates):** آپدیت کد وب بدون نیاز به دانلود مجدد APK و هماهنگی هش نیتیو (Native Key).
- 🌐 **حل تحریم و پروکسی Gradle:** بررسی خودکار میرورهای فعال ایران/چین برای دانلود سریع Gradle و وابستگی‌ها بدون نیاز به فیلترشکن.
- 📱 **نصب و اجرای مستقیم روی گوشی با کابل USB (ADB).**

---

## نحوه استفاده در پروژه‌ها

### ۱. نصب در پروژه

در ریشهٔ هر پروژه مبتنی بر Capacitor (مثل `menchat react` یا `Namdaran react`) دستور زیر را اجرا کنید:

```bash
npm install "file:../capacitor-android-builder" --save-dev
```
*(یا در صورت انتشار روی گیت‌هاب/ریپوزیتوری خصوصی، آدرس گیت را قرار دهید)*

### ۲. اضافه کردن اسکریپت به package.json

در فایل `package.json` پروژه هدف:

```json
"scripts": {
  "android": "capacitor-builder",
  "publish-update": "capacitor-builder publish-update",
  "publish-apk": "capacitor-builder publish-apk",
  "releases": "capacitor-builder releases"
}
```

### ۳. اجرا

حالا با زدن دستور زیر در پروژه:
```bash
npm run android
```
پنجره بصری بیلدر به صورت خودکار باز شده و پروژه فعلی شما را مدیریت می‌کند!

---

## دستورات CLI

```bash
# باز کردن محیط گرافیکی بیلدر
npx capacitor-builder

# انتشار آپدیت داخلی بدون APK (BUMP نسخه z: آپدیت اختیاری)
npx capacitor-builder publish-update --bump z

# انتشار آپدیت داخلی بدون APK (BUMP نسخه y: آپدیت اجباری)
npx capacitor-builder publish-update --bump y

# انتشار آخرین APK ساخته‌شده (نسخه x)
npx capacitor-builder publish-apk

# مدیریت و مشاهده لیست نسخه‌های منتشرشده روی سرور
npx capacitor-builder releases
```

---

## ساخت فایل اجرایی ویندوز (اختیاری)

اگر ترجیح می‌دهید یک فایل `.exe` مستقل با آیکون اختصاصی داشته باشید، در پوشه `launcher` دستور زیر را بزنید:
```bash
cd launcher
build.cmd
```
فایل `AppBuilder.exe` ساخته خواهد شد.
