// 학원별 연결 설정. 학부모 리포트·키오스크·법정 서류·학교 검색·관리자 설정이 이 파일 하나를 읽는다.
// - 이 파일은 학원마다 다르다. 원본 업데이트를 적용할 때 이 파일은 덮어쓰지 않는다.
// - 원본 값을 다른 학원에 복사하지 않는다. 새 학원은 scripts/setup-new-academy.py가 이 파일의 두 값을 바꾼다.
// - 두 값은 브라우저에 공개되는 값(Supabase 주소와 anon 공개 키)이다. 관리자 키·웹훅 키 같은 비밀값은 넣지 않는다.
window.HADA_CONFIG = Object.freeze({
  supabaseUrl: "https://twczhsxybkcvjkdfdxvs.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3Y3poc3h5YmtjdmprZGZkeHZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyOTcwMDQsImV4cCI6MjEwMzg3MzAwNH0.t7Ltb_iSYqE4gHSoGSm-OlpiLjGqIcgrhzGJ-t56EDc",
})
