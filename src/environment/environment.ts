// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyC8NowB65Km88z6opEpc41nxAhHGYVbS88",
  authDomain: "app-taskmanage.firebaseapp.com",
  projectId: "app-taskmanage",
  storageBucket: "app-taskmanage.firebasestorage.app",
  messagingSenderId: "698514039295",
  appId: "1:698514039295:web:1f7ec1313a54d99f1907ca",
  measurementId: "G-D32HT60LBX"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
  